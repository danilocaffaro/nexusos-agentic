#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ENGINES = new Set(["claude_code_cli", "codex_cli"]);
const RUN_PATTERN = /^run_[0-9a-f]{32}$/u;
const CAPTURE_LIMIT = 128 * 1024;
const CAPTURE_TIMEOUT_MS = 60_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const RUNNER_PATH = join(REPOSITORY_ROOT, "runner", "nexus-runner.mjs");
const PRIVATE_ROOT = join(REPOSITORY_ROOT, ".nexusos");
const STATE_DIR = join(PRIVATE_ROOT, "local-runner");

class LocalEngineError extends Error {
  constructor(message, exitCode = 78) {
    super(message);
    this.exitCode = exitCode;
  }
}

export async function runLocalEngineReady(
  rawArguments,
  dependencies = productionDependencies(),
) {
  const options = parseArguments(rawArguments);
  await ensurePrivateDirectory(dependencies.privateRoot);
  await ensurePrivateDirectory(dependencies.stateDir);
  const executablePath = await canonicalExecutable(
    options.executablePath,
  );
  const enrolled = await hasEnrolledRunner(dependencies.stateDir);

  if (enrolled && options.tokenStdin) {
    throw new LocalEngineError(
      "--token-stdin é aceito somente durante a primeira matrícula deste " +
        "estado local; não envie novamente o segredo de bootstrap.",
      64,
    );
  }
  if (!enrolled) {
    if (!options.tokenStdin && !process.stdin.isTTY) {
      throw new LocalEngineError(
        "Este runner ainda não está matriculado. Em um Terminal interativo, " +
          "execute novamente e cole o token da tela Runners no prompt oculto; " +
          "para um pipe deliberado, acrescente --token-stdin.",
        66,
      );
    }
    process.stdout.write(
      "Matrícula local necessária: emita um token de uso único na tela " +
        "Runners e cole-o somente no prompt oculto.\n",
    );
    const enrollmentArguments = [
      "enroll",
      "--server",
      options.server,
      "--name",
      options.name,
      "--state-dir",
      dependencies.stateDir,
      ...(options.tokenStdin ? ["--token-stdin"] : []),
    ];
    await dependencies.runInherited(enrollmentArguments, "matrícula");
  }

  await dependencies.runCaptured(
    [
      "engines",
      "set",
      "--engine",
      options.engine,
      "--path",
      executablePath,
      "--state-dir",
      dependencies.stateDir,
    ],
    "configuração da engine",
  );

  const inventoryResult = await dependencies.runCaptured(
    [
      "engines",
      "report",
      "--dry-run",
      "--state-dir",
      dependencies.stateDir,
    ],
    "probe local da engine",
  );
  const inventory = parseInventory(inventoryResult.stdout);
  printInventory(inventory);
  const selected = inventory.engines.find(
    (candidate) => candidate.engine === options.engine,
  );
  if (!selected || selected.readiness !== "ready") {
    throw new LocalEngineError(
      selected
        ? readinessMessage(selected.reason, options.engine)
        : "A engine solicitada não apareceu no inventário fechado.",
      selected?.reason === "engine_auth_attention_required" ? 77 : 78,
    );
  }

  await dependencies.runCaptured(
    [
      "heartbeat",
      "--server",
      options.server,
      "--state-dir",
      dependencies.stateDir,
    ],
    "heartbeat assinado",
  );
  await dependencies.runCaptured(
    [
      "report-capabilities",
      "--server",
      options.server,
      "--state-dir",
      dependencies.stateDir,
    ],
    "relatório de capacidades",
  );
  await dependencies.runCaptured(
    [
      "engines",
      "report",
      "--server",
      options.server,
      "--state-dir",
      dependencies.stateDir,
    ],
    "publicação do inventário",
  );

  process.stdout.write(
    `Motor local pronto: ${engineLabel(options.engine)} ` +
      `${selected.version ?? "versão não informada"}; inventário assinado ` +
      "publicado sem credenciais de provider.\n",
  );
  if (options.runId) {
    process.stdout.write(
      `Iniciando somente ${options.runId}. O prompt continua protegido no ` +
        "control plane e não entra neste comando ou em seus logs.\n",
    );
  } else {
    process.stdout.write(
      "Serve ativo em heartbeat/recovery, sem buscar trabalho ambiente. " +
        "Crie explicitamente uma análise one-shot na tela Runners; depois " +
        "encerre com Ctrl+C e execute este comando com --run <run_id>.\n",
    );
  }

  await dependencies.runInherited(
    [
      "serve",
      "--server",
      options.server,
      "--state-dir",
      dependencies.stateDir,
      ...(options.runId
        ? ["--run", options.runId, "--engine", options.engine]
        : []),
    ],
    "serve",
  );
}

function productionDependencies() {
  return {
    privateRoot: PRIVATE_ROOT,
    stateDir: STATE_DIR,
    runCaptured(argumentsList, phase) {
      return runRunner(argumentsList, phase, "capture");
    },
    runInherited(argumentsList, phase) {
      return runRunner(argumentsList, phase, "inherit");
    },
  };
}

function parseArguments(rawArguments) {
  const values = new Map();
  let tokenStdin = false;
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--token-stdin") {
      if (tokenStdin) {
        throw new LocalEngineError(
          "Uma opção foi informada mais de uma vez.",
          64,
        );
      }
      tokenStdin = true;
      continue;
    }
    if (
      ![
        "--engine",
        "--name",
        "--path",
        "--run",
        "--server",
      ].includes(argument)
    ) {
      throw new LocalEngineError("Opção não suportada.", 64);
    }
    const value = rawArguments[index + 1];
    if (!value || value.startsWith("--")) {
      throw new LocalEngineError("Uma opção está sem valor.", 64);
    }
    if (values.has(argument)) {
      throw new LocalEngineError(
        "Uma opção foi informada mais de uma vez.",
        64,
      );
    }
    values.set(argument, value);
    index += 1;
  }

  const engine = values.get("--engine");
  const executablePath = values.get("--path");
  if (!engine || !executablePath) {
    throw new LocalEngineError(
      "Use --engine <claude_code_cli|codex_cli> e --path <caminho-absoluto>.",
      64,
    );
  }
  if (!ENGINES.has(engine)) {
    throw new LocalEngineError("A engine solicitada não é suportada.", 64);
  }
  if (!isAbsolute(executablePath)) {
    throw new LocalEngineError(
      "--path deve ser um caminho absoluto para o CLI exato.",
      64,
    );
  }
  const name = values.get("--name") ?? "nexusos-local-engine";
  if (
    name.length < 1 ||
    name.length > 120 ||
    name !== name.trim()
  ) {
    throw new LocalEngineError(
      "--name deve ter de 1 a 120 caracteres sem espaços externos.",
      64,
    );
  }
  const runId = values.get("--run");
  if (runId && !RUN_PATTERN.test(runId)) {
    throw new LocalEngineError(
      "--run deve ser um run_id canônico do NexusOS.",
      64,
    );
  }
  return {
    engine,
    executablePath,
    name,
    runId,
    server: values.get("--server") ?? "http://127.0.0.1:3002",
    tokenStdin,
  };
}

async function canonicalExecutable(path) {
  let canonical;
  let metadata;
  try {
    canonical = await realpath(path);
    metadata = await lstat(canonical);
  } catch {
    throw new LocalEngineError(
      "O caminho exato do CLI não existe ou não pode ser lido.",
      66,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new LocalEngineError(
      "O caminho exato do CLI deve resolver para um arquivo regular.",
      78,
    );
  }
  return canonical;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new LocalEngineError(
      "O diretório privado local é inválido ou inseguro.",
      78,
    );
  }
  await chmod(path, 0o700);
}

async function hasEnrolledRunner(stateDir) {
  try {
    const metadata = await lstat(join(stateDir, "runner.json"));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LocalEngineError(
        "O estado de matrícula local é inválido ou inseguro.",
        78,
      );
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseInventory(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new LocalEngineError(
      "O runner retornou um inventário de engines inválido.",
      76,
    );
  }
  if (
    !value ||
    !Array.isArray(value.engines) ||
    value.engines.length !== 2 ||
    !value.engines.every(
      (item) =>
        item &&
        ENGINES.has(item.engine) &&
        ["ready", "attention_required", "unknown"].includes(item.readiness) &&
        typeof item.reason === "string" &&
        typeof item.status === "string",
    )
  ) {
    throw new LocalEngineError(
      "O runner retornou um inventário de engines inválido.",
      76,
    );
  }
  return value;
}

function printInventory(inventory) {
  process.stdout.write("Inventário local observado agora:\n");
  for (const item of inventory.engines) {
    process.stdout.write(
      `- ${engineLabel(item.engine)}: ${item.status}/${item.readiness}` +
        ` (${item.reason})${item.version ? ` · ${item.version}` : ""}\n`,
    );
  }
}

function readinessMessage(reason, engine) {
  const label = engineLabel(engine);
  if (reason === "engine_auth_attention_required") {
    return `${label} foi encontrado, mas o próprio CLI informou que o login requer atenção. Autentique-o localmente e tente novamente.`;
  }
  if (reason === "engine_incompatible") {
    return `${label} foi encontrado, mas versão ou flags não correspondem ao contrato fixado pelo runner.`;
  }
  if (reason === "engine_binary_invalid") {
    return `${label} não passou nas verificações de caminho, ownership e permissões do runner.`;
  }
  if (reason === "engine_probe_failed") {
    return `${label} não respondeu de forma válida aos probes locais limitados.`;
  }
  return `${label} não está pronto (${reason}).`;
}

function engineLabel(engine) {
  return engine === "claude_code_cli" ? "Claude Code CLI" : "Codex CLI";
}

async function runRunner(argumentsList, phase, stdioMode) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [RUNNER_PATH, ...argumentsList], {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      stdio:
        stdioMode === "inherit"
          ? "inherit"
          : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const timeout =
      stdioMode === "capture"
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, CAPTURE_TIMEOUT_MS)
        : undefined;
    if (stdioMode === "capture") {
      const collect = (chunk, target) => {
        if (overflow) return;
        const next = target() + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > CAPTURE_LIMIT) {
          overflow = true;
          child.kill("SIGTERM");
          return;
        }
        if (target === readStdout) stdout = next;
        else stderr = next;
      };
      const readStdout = () => stdout;
      const readStderr = () => stderr;
      child.stdout.on("data", (chunk) => collect(chunk, readStdout));
      child.stderr.on("data", (chunk) => collect(chunk, readStderr));
    }
    child.once("error", () => {
      if (timeout) clearTimeout(timeout);
      rejectRun(
        new LocalEngineError(`Não foi possível iniciar ${phase}.`, 74),
      );
    });
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        rejectRun(
          new LocalEngineError(
            `${phase} excedeu o prazo local de 60 segundos.`,
            75,
          ),
        );
        return;
      }
      if (overflow) {
        rejectRun(
          new LocalEngineError(
            `${phase} excedeu o limite local de saída.`,
            76,
          ),
        );
        return;
      }
      if (code !== 0) {
        rejectRun(
          new LocalEngineError(
            `${phase} falhou com código ${code ?? `signal:${signal}`}.`,
            Number.isInteger(code) ? code : 1,
          ),
        );
        return;
      }
      resolveRun({ stdout, stderr });
    });
  });
}

function printHelp() {
  process.stdout.write(`NexusOS local engine bootstrap

Uso:
  npm run local:engine -- --engine <claude_code_cli|codex_cli> --path <absoluto> [--server <origin>] [--name <nome>] [--token-stdin] [--run <run_id>]

O comando usa somente ${basename(PRIVATE_ROOT)}/local-runner dentro do projeto.
Sem --run, publica readiness e mantém heartbeat/recovery, sem buscar trabalho.
Com --run, tenta somente o run explicitamente atribuído; não cria run, prompt,
aprovação ou ActionIntent e não habilita tools, MCPs ou mutação do workspace.
`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    const canonical = realpathSync.native ?? realpathSync;
    return canonical(process.argv[1]) === canonical(SCRIPT_PATH);
  } catch {
    return resolve(process.argv[1]) === resolve(SCRIPT_PATH);
  }
}

if (isDirectExecution()) {
  if (
    process.argv.length === 3 &&
    ["--help", "-h", "help"].includes(process.argv[2])
  ) {
    printHelp();
  } else {
    runLocalEngineReady(process.argv.slice(2)).catch((error) => {
      const normalized =
        error instanceof LocalEngineError
          ? error
          : new LocalEngineError(
              "O bootstrap do motor local falhou de forma segura.",
              1,
            );
      process.stderr.write(`nexus-local-engine: ${normalized.message}\n`);
      process.exitCode = normalized.exitCode;
    });
  }
}
