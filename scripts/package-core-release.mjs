#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const RELEASE_SCHEMA_VERSION = 1;
const PRODUCT_SLUG = "nexusos-core-local";
const SUPPORTED_PLATFORMS = Object.freeze(["darwin", "linux"]);
const UNSUPPORTED_PLATFORMS = Object.freeze(["win32"]);
const RELEASE_FILES = Object.freeze([
  ".env.example",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "cloudflare-env.d.ts",
  "docs/ARCHITECTURE.md",
  "docs/BACKUP-RESTORE.md",
  "docs/BUSINESS-RULES.md",
  "docs/INSTALL.md",
  "docs/REMOTE-ACCESS.md",
  "docs/RELEASE.md",
  "docs/THREAT-MODEL.md",
  "docs/UPGRADE.md",
  "drizzle.config.ts",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "scripts/deadline-reconcile.mjs",
  "scripts/lease-preflight.mjs",
  "scripts/local-engine-ready.mjs",
  "scripts/package-core-release.mjs",
  "scripts/release-checksums.mjs",
  "scripts/retention-reconcile.mjs",
  "scripts/remote-init.mjs",
  "scripts/remote-macos-service.mjs",
  "scripts/remote-ready.mjs",
  "scripts/usable-local.mjs",
  "scripts/verify-release-tag.mjs",
  "sql-raw.d.ts",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.local.jsonc",
]);
const RELEASE_DIRECTORIES = Object.freeze([
  "app",
  "build",
  "db",
  "drizzle",
  "ops",
  "public",
  "runner",
  "src",
  "worker",
]);

export async function packageCoreLocalRelease(options = {}) {
  const repositoryRoot = resolve(
    options.repositoryRoot ?? REPOSITORY_ROOT,
  );
  const outputDirectory = resolve(
    options.outputDirectory ?? join(repositoryRoot, "release"),
  );
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assertPackageMetadata(packageJson);

  const commit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!options.allowDirty) {
    const status = await git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status) {
      throw new TypeError(
        "Release packaging requires a clean Git worktree.",
      );
    }
  }
  const sourceDateEpoch = await resolveSourceDateEpoch(
    repositoryRoot,
    commit,
    options.sourceDateEpoch,
  );
  const sourceEntries = await collectReleaseEntries(repositoryRoot);
  const databaseSchema = migrationSchema(sourceEntries);
  const manifest = canonicalJson({
    channel: "github-releases",
    commit,
    databaseSchema,
    packageName: packageJson.name,
    product: "NexusOS",
    runtimeProfiles: ["local", "remote"],
    schemaVersion: RELEASE_SCHEMA_VERSION,
    sourceDateEpoch,
    supportedPlatforms: SUPPORTED_PLATFORMS,
    unsupportedPlatforms: UNSUPPORTED_PLATFORMS,
    version: packageJson.version,
  });
  const manifestBytes = Buffer.from(`${manifest}\n`, "utf8");
  const root = `${PRODUCT_SLUG}-${packageJson.version}`;
  const archiveEntries = [
    {
      bytes: manifestBytes,
      path: `${root}/RELEASE-MANIFEST.json`,
    },
    ...sourceEntries.map((entry) => ({
      bytes: entry.bytes,
      path: `${root}/${entry.path}`,
    })),
  ];
  const archiveBytes = deterministicGzip(
    createTar(archiveEntries, sourceDateEpoch),
  );
  const archiveName =
    `${PRODUCT_SLUG}-${packageJson.version}-source.tgz`;
  const manifestName =
    `${PRODUCT_SLUG}-${packageJson.version}.manifest.json`;

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, archiveName), archiveBytes);
  await writeFile(join(outputDirectory, manifestName), manifestBytes);
  const checksumLines = [
    checksumLine(archiveName, archiveBytes),
    checksumLine(manifestName, manifestBytes),
  ].sort();
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
    "utf8",
  );
  return Object.freeze({
    archiveName,
    commit,
    manifestName,
    outputDirectory,
    sourceDateEpoch,
  });
}

async function collectReleaseEntries(repositoryRoot) {
  const paths = [...RELEASE_FILES];
  for (const directory of RELEASE_DIRECTORIES) {
    paths.push(...(await walkRegularFiles(repositoryRoot, directory)));
  }
  const trackedPaths = new Set(
    (await git(repositoryRoot, ["ls-files", "-z"]))
      .split("\0")
      .filter(Boolean),
  );
  const unique = [...new Set(paths)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  const entries = [];
  for (const path of unique) {
    assertReleasePath(path);
    if (!trackedPaths.has(path)) {
      throw new TypeError(
        `Release entry is not a tracked source file: ${path}`,
      );
    }
    const absolute = join(repositoryRoot, ...path.split("/"));
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(`Release entry is not a regular file: ${path}`);
    }
    entries.push({ bytes: await readFile(absolute), path });
  }
  return entries;
}

async function walkRegularFiles(repositoryRoot, relativeDirectory) {
  const absoluteDirectory = join(
    repositoryRoot,
    ...relativeDirectory.split("/"),
  );
  const metadata = await lstat(absoluteDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(
      `Release directory is not a regular directory: ${relativeDirectory}`,
    );
  }
  const result = [];
  const names = await readdir(absoluteDirectory);
  names.sort((left, right) => left.localeCompare(right, "en"));
  for (const name of names) {
    const path = posix.join(relativeDirectory, name);
    const child = await lstat(join(repositoryRoot, ...path.split("/")));
    if (child.isSymbolicLink()) {
      throw new TypeError(`Release entry may not be a symlink: ${path}`);
    }
    if (child.isDirectory()) {
      result.push(...(await walkRegularFiles(repositoryRoot, path)));
    } else if (child.isFile()) {
      result.push(path);
    } else {
      throw new TypeError(`Unsupported release entry: ${path}`);
    }
  }
  return result;
}

function assertReleasePath(path) {
  const forbiddenSegments = new Set([
    ".git",
    ".nexusos",
    ".openai",
    ".wrangler",
    "dist",
    "node_modules",
    "release",
    "tests",
  ]);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    segments.includes("..") ||
    path.includes("\\") ||
    segments.some((segment) => forbiddenSegments.has(segment)) ||
    path === "docs/qa" ||
    path.startsWith("docs/qa/") ||
    (
      segments.some((segment) => segment.startsWith(".env")) &&
      path !== ".env.example"
    )
  ) {
    throw new TypeError(`Forbidden release path: ${path}`);
  }
}

function migrationSchema(entries) {
  const migrations = entries
    .map((entry) => entry.path)
    .filter((path) => /^drizzle\/\d{4}[^/]*\.sql$/u.test(path))
    .sort();
  if (migrations.length === 0) {
    throw new TypeError("Release contains no database migrations.");
  }
  return Object.freeze({
    count: migrations.length,
    latest: migrations.at(-1).slice("drizzle/".length),
  });
}

function assertPackageMetadata(value) {
  if (
    !value ||
    value.name !== "@danilocaffaro/nexusos" ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version) ||
    value.private !== true ||
    value.license !== "Apache-2.0"
  ) {
    throw new TypeError("Release package metadata is not approved.");
  }
}

async function resolveSourceDateEpoch(
  repositoryRoot,
  commit,
  explicit,
) {
  const value =
    explicit ??
    process.env.SOURCE_DATE_EPOCH ??
    (await git(repositoryRoot, ["show", "-s", "--format=%ct", commit]));
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > 8_589_934_591
  ) {
    throw new TypeError("SOURCE_DATE_EPOCH is invalid.");
  }
  return parsed;
}

function createTar(entries, sourceDateEpoch) {
  const chunks = [];
  for (const entry of entries) {
    const header = tarHeader(entry.path, entry.bytes.length, sourceDateEpoch);
    chunks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function tarHeader(path, size, sourceDateEpoch) {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(512);
  writeUtf8(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeUtf8(header, 257, 6, "ustar");
  writeUtf8(header, 263, 2, "00");
  writeUtf8(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeUtf8(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
  );
  return header;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new TypeError(`Release path exceeds ustar limits: ${path}`);
}

function writeUtf8(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new TypeError("Tar field overflow.");
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new TypeError("Tar number overflow.");
  writeUtf8(buffer, offset, length, `${encoded}\0`);
}

function deterministicGzip(bytes) {
  const compressed = Buffer.from(
    gzipSync(bytes, { level: 9, mtime: 0 }),
  );
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  return compressed;
}

function checksumLine(name, bytes) {
  return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function git(cwd, args) {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectGit);
    child.once("close", (code) => {
      if (code === 0) resolveGit(stdout.trim());
      else rejectGit(new Error(`git failed (${code}): ${stderr.trim()}`));
    });
  });
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  const outputIndex = process.argv.indexOf("--output-dir");
  const outputDirectory =
    outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
  if (
    process.argv.length !== (outputIndex === -1 ? 2 : 4) ||
    (outputIndex !== -1 && !outputDirectory)
  ) {
    process.stderr.write(
      "usage: npm run package:release -- [--output-dir PATH]\n",
    );
    process.exitCode = 64;
  } else {
    packageCoreLocalRelease({ outputDirectory })
      .then((result) => {
        process.stdout.write(
          `${join(result.outputDirectory, result.archiveName)}\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(
          `nexus-core-release: ${
            error instanceof Error ? error.message : "packaging failed"
          }\n`,
        );
        process.exitCode = 1;
      });
  }
}
