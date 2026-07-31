#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(process.argv[2] ?? "release");
const checksumPath = resolve(outputDirectory, "SHA256SUMS");

const files = [];
for (const name of await readdir(outputDirectory)) {
  if (name === "SHA256SUMS") continue;
  const path = resolve(outputDirectory, name);
  if ((await stat(path)).isFile()) files.push({ name, path });
}
files.sort((left, right) => left.name.localeCompare(right.name, "en"));
if (files.length === 0) {
  throw new TypeError("No release files are available for checksums.");
}

const lines = [];
for (const file of files) {
  const digest = createHash("sha256")
    .update(await readFile(file.path))
    .digest("hex");
  lines.push(`${digest}  ${file.name}`);
}
await writeFile(checksumPath, `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`${checksumPath}\n`);
