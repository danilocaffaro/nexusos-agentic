import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  packageCoreLocalRelease,
} from "../scripts/package-core-release.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname;

test("Core Local release archive is reproducible and allowlisted", async () => {
  const firstDirectory = await mkdtemp(
    join(tmpdir(), "nexusos-core-release-a-"),
  );
  const secondDirectory = await mkdtemp(
    join(tmpdir(), "nexusos-core-release-b-"),
  );
  const options = {
    allowDirty: true,
    repositoryRoot,
    sourceDateEpoch: 1_753_836_846,
  };
  const first = await packageCoreLocalRelease({
    ...options,
    outputDirectory: firstDirectory,
  });
  const second = await packageCoreLocalRelease({
    ...options,
    outputDirectory: secondDirectory,
  });
  const firstArchive = await readFile(
    join(firstDirectory, first.archiveName),
  );
  const secondArchive = await readFile(
    join(secondDirectory, second.archiveName),
  );
  assert.deepEqual(firstArchive, secondArchive);
  assert.deepEqual(
    await readFile(join(firstDirectory, first.manifestName)),
    await readFile(join(secondDirectory, second.manifestName)),
  );
  assert.deepEqual(
    await readFile(join(firstDirectory, "SHA256SUMS")),
    await readFile(join(secondDirectory, "SHA256SUMS")),
  );
  assert.equal(firstArchive.readUInt32LE(4), 0);
  assert.equal(firstArchive[9], 255);

  const entries = readTar(gunzipSync(firstArchive));
  const root = "nexusos-core-local-0.1.0/";
  const paths = [...entries.keys()];
  assert.ok(paths.every((path) => path.startsWith(root)));
  assert.ok(entries.has(`${root}RELEASE-MANIFEST.json`));
  assert.ok(entries.has(`${root}LICENSE`));
  assert.ok(entries.has(`${root}package-lock.json`));
  assert.ok(entries.has(`${root}scripts/usable-local.mjs`));
  assert.ok(
    entries.has(
      `${root}drizzle/0030_decision_ledger_append_only.sql`,
    ),
  );
  assert.equal(
    paths.some((path) => path.includes("/.openai/")),
    false,
  );
  assert.equal(paths.some((path) => path.includes("/tests/")), false);
  assert.equal(paths.some((path) => path.includes("/docs/qa/")), false);
  assert.equal(paths.some((path) => path.includes("/.wrangler/")), false);
  assert.equal(paths.some((path) => path.includes("/.nexusos/")), false);
  assert.equal(
    paths.some(
      (path) =>
        path.includes("/.env") && !path.endsWith("/.env.example"),
    ),
    false,
  );
  assert.equal(
    paths.some((path) => path.endsWith("/.openai/hosting.json")),
    false,
  );
  for (const entry of entries.values()) {
    assert.equal(entry.mode, 0o644);
    assert.equal(entry.uid, 0);
    assert.equal(entry.gid, 0);
    assert.equal(entry.mtime, 1_753_836_846);
    assert.equal(entry.type, "0");
  }

  const manifest = JSON.parse(
    entries.get(`${root}RELEASE-MANIFEST.json`).bytes.toString("utf8"),
  );
  assert.deepEqual(manifest.supportedPlatforms, ["darwin", "linux"]);
  assert.deepEqual(manifest.unsupportedPlatforms, ["win32"]);
  assert.equal(manifest.packageName, "@danilocaffaro/nexusos");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.databaseSchema.count, 31);
  assert.equal(
    manifest.databaseSchema.latest,
    "0030_decision_ledger_append_only.sql",
  );
  assert.match(manifest.commit, /^[0-9a-f]{40}$/u);

  const checksumText = await readFile(
    join(firstDirectory, "SHA256SUMS"),
    "utf8",
  );
  assert.match(
    checksumText,
    new RegExp(
      `^${sha256(firstArchive)}  ${escapeRegExp(first.archiveName)}$`,
      "mu",
    ),
  );
});

test("Core Local release rejects ignored files inside source directories", async () => {
  const ignoredPath = join(
    repositoryRoot,
    "public",
    "nexusos-release-secret.pem",
  );
  await writeFile(ignoredPath, "must-not-ship\n", "utf8");
  try {
    await assert.rejects(
      packageCoreLocalRelease({
        allowDirty: true,
        outputDirectory: await mkdtemp(
          join(tmpdir(), "nexusos-core-release-secret-"),
        ),
        repositoryRoot,
        sourceDateEpoch: 1_753_836_846,
      }),
      /Release entry is not a tracked source file/u,
    );
  } finally {
    await unlink(ignoredPath);
  }
});

function readTar(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readString(header, 124, 12), 8);
    assert.ok(Number.isSafeInteger(size));
    const bodyStart = offset + 512;
    entries.set(path, {
      bytes: bytes.subarray(bodyStart, bodyStart + size),
      gid: readOctal(header, 116, 8),
      mode: readOctal(header, 100, 8),
      mtime: readOctal(header, 136, 12),
      type: String.fromCharCode(header[156]),
      uid: readOctal(header, 108, 8),
    });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readString(bytes, offset, length) {
  return bytes
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/u, "")
    .trim();
}

function readOctal(bytes, offset, length) {
  const parsed = Number.parseInt(readString(bytes, offset, length), 8);
  assert.ok(Number.isSafeInteger(parsed));
  return parsed;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
