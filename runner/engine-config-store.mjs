import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  encodeEngineConfiguration,
  ENGINE_CONFIG_MAX_BYTES,
  parseEngineConfiguration,
} from "./engine-probes.mjs";

const CONFIGURATION_NAME = "engines.json";
const EMPTY_CONFIGURATION = Object.freeze({
  engines: Object.freeze({}),
  schemaVersion: 1,
});

export class EngineConfigStoreError extends Error {
  constructor(message) {
    super(message);
    this.code = "engine_config_invalid";
  }
}

export function engineConfigurationPath(stateDir) {
  return join(stateDir, CONFIGURATION_NAME);
}

export async function readEngineConfiguration(stateDir) {
  const path = engineConfigurationPath(stateDir);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return parseEngineConfiguration(
        encodeEngineConfiguration(EMPTY_CONFIGURATION),
      );
    }
    throw invalidConfiguration();
  }

  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 1 ||
      metadata.size > ENGINE_CONFIG_MAX_BYTES ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      throw invalidConfiguration();
    }
    const bytes = await boundedRead(handle);
    return parseEngineConfiguration(bytes);
  } catch (error) {
    if (error instanceof EngineConfigStoreError) throw error;
    throw invalidConfiguration();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeEngineConfiguration(
  stateDir,
  configuration,
) {
  let text;
  try {
    text = encodeEngineConfiguration(configuration);
  } catch {
    throw invalidConfiguration();
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > ENGINE_CONFIG_MAX_BYTES) {
    throw invalidConfiguration();
  }

  const finalPath = engineConfigurationPath(stateDir);
  const temporary = join(
    stateDir,
    `.${CONFIGURATION_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, finalPath);
    await syncDirectory(stateDir);
  } catch (error) {
    if (error instanceof EngineConfigStoreError) throw error;
    throw invalidConfiguration();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function boundedRead(handle) {
  const bytes = Buffer.alloc(ENGINE_CONFIG_MAX_BYTES + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      null,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset < 1 || offset > ENGINE_CONFIG_MAX_BYTES) {
    throw invalidConfiguration();
  }
  return bytes.subarray(0, offset);
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function invalidConfiguration() {
  return new EngineConfigStoreError(
    "Local engine configuration is invalid or unsafe.",
  );
}
