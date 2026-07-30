#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BREAKPOINT = "--> statement-breakpoint";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");

export function compactSitesMigration(sql) {
  if (typeof sql !== "string" || sql.length === 0) {
    throw new TypeError("A Sites migration must be non-empty SQL.");
  }
  const statements = sql.split(BREAKPOINT);
  if (statements.some((statement) => statement.trim().length === 0)) {
    throw new TypeError("A Sites migration contains an empty SQL chunk.");
  }
  return statements
    .map((statement) => compactSqlStatement(statement))
    .join(`${BREAKPOINT}\n`);
}

function compactSqlStatement(sql) {
  let output = "";
  let pendingSpace = false;
  let quote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
        continue;
      }
      if (character !== quote) continue;
      if (next === quote) {
        output += next;
        index += 1;
      } else {
        quote = null;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && !/[\r\n]/u.test(sql[index])) {
        index += 1;
      }
      pendingSpace = output.length > 0;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < sql.length - 1 &&
        !(sql[index] === "*" && sql[index + 1] === "/")
      ) {
        index += 1;
      }
      if (index >= sql.length - 1) {
        throw new TypeError("A Sites migration contains an open SQL comment.");
      }
      index += 1;
      pendingSpace = output.length > 0;
      continue;
    }
    if (/\s/u.test(character)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) {
      output += " ";
      pendingSpace = false;
    }
    output += character;
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "[") {
      quote = "]";
    }
  }

  if (quote) {
    throw new TypeError("A Sites migration contains an open SQL quote.");
  }
  const compacted = output.trim();
  if (!compacted) {
    throw new TypeError("A Sites migration contains an empty SQL statement.");
  }
  return compacted;
}

export async function packageSitesReady(
  archivePath,
  repositoryRoot = REPOSITORY_ROOT,
) {
  const archive = resolve(archivePath);
  const buildSource = join(repositoryRoot, "dist");
  const hostingSource = join(repositoryRoot, ".openai", "hosting.json");
  const drizzleSource = join(repositoryRoot, "drizzle");

  await requireFile(join(buildSource, "server", "index.js"));
  await requireFile(hostingSource);

  const stage = await mkdtemp(join(tmpdir(), "nexusos-sites-package-"));
  try {
    const buildTarget = join(stage, "dist");
    const metadataTarget = join(buildTarget, ".openai");
    const drizzleTarget = join(metadataTarget, "drizzle");
    await cp(buildSource, buildTarget, { recursive: true });
    await mkdir(metadataTarget, { recursive: true });
    await cp(hostingSource, join(metadataTarget, "hosting.json"));
    await rm(drizzleTarget, { recursive: true, force: true });
    await cp(drizzleSource, drizzleTarget, { recursive: true });

    const entries = await readdir(drizzleSource);
    for (const entry of entries.filter((name) => name.endsWith(".sql"))) {
      const source = await readFile(join(drizzleSource, entry), "utf8");
      const compacted = compactSitesMigration(source);
      await writeFile(join(drizzleTarget, entry), `${compacted}\n`, "utf8");
    }

    await mkdir(dirname(archive), { recursive: true });
    await runTar(stage, archive);
    await requireFile(archive);
    return archive;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function requireFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new TypeError(`Required package file is not regular: ${path}`);
  }
}

function runTar(stage, archive) {
  return new Promise((resolveTar, rejectTar) => {
    const child = spawn("tar", ["-C", stage, "-czf", archive, "dist"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.once("error", rejectTar);
    child.once("close", (code) => {
      if (code === 0) resolveTar();
      else rejectTar(new Error(`tar failed (${code}): ${output}`));
    });
  });
}

function isDirectExecution() {
  return process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH;
}

if (isDirectExecution()) {
  const archive = process.argv[2];
  if (!archive || process.argv.length !== 3) {
    process.stderr.write(
      "usage: npm run sites:package -- /absolute/archive.tgz\n",
    );
    process.exitCode = 64;
  } else {
    packageSitesReady(archive)
      .then((path) => process.stdout.write(`${path}\n`))
      .catch((error) => {
        process.stderr.write(
          `nexus-sites-package: ${
            error instanceof Error ? error.message : "packaging failed"
          }\n`,
        );
        process.exitCode = 1;
      });
  }
}
