#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = `v${packageJson.version}`;

if (!tag || tag !== expected) {
  process.stderr.write(
    `Release tag mismatch: expected ${expected}, received ${tag ?? "none"}.\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`${tag}\n`);
}
