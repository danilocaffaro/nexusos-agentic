import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunnerDeclarationPanel,
  RunnersView,
  runnerError,
  shellQuote,
} from "../../app/runners-view";
import type { Runner } from "../../src/contracts/runners";

test("labels runner identity, diagnostic leases and deferred execution truthfully", () => {
  const html = renderToStaticMarkup(
    createElement(RunnersView, { notify: () => undefined }),
  );
  assert.match(html, /RUNNER CONTROL PLANE · REAL · S6\.B2/);
  assert.match(html, /Identidade/);
  assert.match(html, /Heartbeat/);
  assert.match(html, /Lease/);
  assert.match(html, /Replay/);
  assert.match(html, /Declarações/);
  assert.match(html, /DECLARADO/);
  assert.match(html, /Execução/);
  assert.match(html, /Sandbox/);
  assert.match(html, /Streaming/);
  assert.match(html, /Identidade verificada não significa isolamento/);
  assert.match(html, /Anyone holding the private key can act as this runner/);
  assert.match(html, /Sem shell ou tools nesta versão/);
  assert.match(html, /FENCED DIAGNOSTIC · S6\.B2/);
  assert.match(html, /Não abre shell nem provider CLI/);
});

test("declaration UI separates host assertions from claim authority", () => {
  const source = readFileSync(
    new URL("../../app/runners-view.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /DECLARADO · hostReported/);
  assert.match(source, /Recebido pelo servidor/);
  assert.match(source, /Coleta informada pelo host/);
  assert.match(source, /Declaração incompleta/);
  assert.match(source, /servidor reavalia[\s\S]+no claim/);
  assert.doesNotMatch(source, /Host ainda não atestado/);
  assert.doesNotMatch(source, /Online não significa sandboxed/);
});

test("renders server and host declaration facts without a claim promise", () => {
  const runner = {
    id: `rnr_${"1".repeat(32)}`,
    organizationId: "org-local-aurora",
    principalId: `prn_${"1".repeat(32)}`,
    displayName: "qa-runner",
    publicKey: "public-key",
    publicKeyFingerprint: "SHA256:fingerprint",
    trustProfile: "operator_trust",
    trustDisclosure: "operator-controlled host",
    status: "active",
    liveness: "online",
    enrolledAt: "2026-07-26T10:00:00.000Z",
    declaredCapabilities: {
      reportId: `cap_${"1".repeat(32)}`,
      schemaVersion: 1,
      trust: "hostReported",
      collectedAt: "2026-07-26T11:59:00.000Z",
      receivedAt: "2026-07-26T12:00:00.000Z",
      ageSeconds: 60,
      platform: {
        os: "linux",
        arch: "x64",
        nodeVersion: "v22.14.0",
      },
      truncated: true,
      capabilities: [
        {
          capability: "bubblewrap",
          status: "available",
          detection: "binary_version",
          reasonCode: "none",
          version: "0.11.0",
        },
      ],
    },
    declarationAdmission: {
      evaluatedAt: "2026-07-26T12:01:00.000Z",
      policySource: "configured",
      policyVersion: 4,
      freshnessSeconds: 3_600,
      freshnessState: "fresh",
      reportId: `cap_${"1".repeat(32)}`,
      reportReceivedAt: "2026-07-26T12:00:00.000Z",
      freshUntil: "2026-07-26T13:00:00.000Z",
      capabilities: [
        {
          capability: "bubblewrap",
          allowed: true,
          declaredStatus: "available",
          declarationSatisfied: true,
          reason: "satisfied",
        },
      ],
    },
  } satisfies Runner;
  const html = renderToStaticMarkup(
    createElement(RunnerDeclarationPanel, {
      runner,
      disclosure: "Afirmação do host; não prova isolamento.",
    }),
  );

  assert.match(html, /hostReported · não verificada/);
  assert.match(html, /1 de 1 capacidades declaradas/);
  assert.match(html, /Declaração incompleta/);
  assert.match(html, /Coleta informada pelo host/);
  assert.match(html, /linux · x64 · v22\.14\.0/);
  assert.match(html, /configurada · v4/);
  assert.match(html, /versão em probe fixa · sem ressalva declarada/);
  assert.match(html, /servidor reavalia[\s\S]+no claim/);
});

test("setup command is shell-safe and the source never interpolates the token", () => {
  assert.equal(shellQuote("runner's host"), `'runner'"'"'s host'`);
  const source = readFileSync(
    new URL("../../app/runners-view.tsx", import.meta.url),
    "utf8",
  );
  const setupCommandBlock = source.slice(
    source.indexOf("const setupCommand"),
    source.indexOf("const issueToken"),
  );
  assert.doesNotMatch(setupCommandBlock, /issuedToken\.token/);
  assert.doesNotMatch(setupCommandBlock, /window\.location\.origin/);
  assert.match(setupCommandBlock, /state\.audience/);
  assert.match(source, /SEGREDO EXIBIDO UMA ÚNICA VEZ/);
  assert.match(source, /o token bootstrap[\s\S]+nunca entra no comando/i);
});

test("diagnostic command contains only an opaque run id", () => {
  const source = readFileSync(
    new URL("../../app/diagnostic-runs-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /npm run runner -- diagnose --run \$\{selected\.run\.id\}/,
  );
  assert.doesNotMatch(source, /token|privateKey|authorization/i);
  assert.match(source, /Duplicates absorvidos/);
  assert.match(source, /Outcome registrado uma vez/);
});

test("maps governed runner failures to actionable copy", () => {
  assert.match(runnerError(new Error("forbidden")), /owner\/admin/i);
  assert.match(runnerError(new Error("runner_token_consumed")), /consumido/i);
  assert.match(runnerError(new Error("conflict_retry")), /contenção/i);
});
