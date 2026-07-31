import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunnerDeclarationPanel,
  RunnersView,
  runnerCapabilityStates,
  runnerError,
  shellQuote,
} from "../../app/runners-view";
import type { Runner, RunnerRegistry } from "../../src/contracts/runners";

function capabilityCardState(
  html: string,
  label: string,
): "REAL" | "INATIVO" | null {
  const cards = html.matchAll(
    /<article class="is-(real|inactive)">([\s\S]*?)<\/article>/gu,
  );
  for (const card of cards) {
    if (card[2].includes(`<h2>${label}</h2>`)) {
      return card[1] === "real" ? "REAL" : "INATIVO";
    }
  }
  return null;
}

test("labels runner identity, declarations, diagnostic leases and one-shot execution truthfully", () => {
  const html = renderToStaticMarkup(
    createElement(RunnersView, { notify: () => undefined }),
  );
  assert.match(html, /RUNNER CONTROL PLANE · PERSISTENTE/);
  assert.match(html, /Identidade/);
  assert.match(html, /Heartbeat/);
  assert.match(html, /Lease/);
  assert.match(html, /Replay/);
  assert.match(html, /Declarações/);
  assert.match(html, /Canal real · conteúdo hostReported não verificado/);
  assert.match(html, /Execução one-shot/);
  assert.match(html, /Sandbox/);
  assert.match(html, /Streaming/);
  assert.match(html, /Identidade verificada não significa isolamento/);
  assert.match(html, /Anyone holding the private key can act as this runner/);
  assert.match(html, /Provider CLI atribuído · sem retry, fallback ou tools/);
  assert.match(html, /FENCED DIAGNOSTIC · PERSISTENTE/);
  assert.match(html, /Não abre shell nem provider CLI/);
  assert.equal(capabilityCardState(html, "Identidade"), "REAL");
  assert.equal(capabilityCardState(html, "Heartbeat"), "REAL");
  assert.equal(capabilityCardState(html, "Lease"), "REAL");
  assert.equal(capabilityCardState(html, "Replay"), "REAL");
  assert.equal(capabilityCardState(html, "Declarações"), "REAL");
  assert.equal(capabilityCardState(html, "Execução one-shot"), "REAL");
  assert.equal(capabilityCardState(html, "Sandbox"), "INATIVO");
  assert.equal(capabilityCardState(html, "Streaming"), "INATIVO");
  assert.doesNotMatch(html, /ROADMAP|S6\.B[0-9]/u);
});

test("truth-label gate rejects prohibited host claims and deferred REAL states", () => {
  const html = renderToStaticMarkup(
    createElement(RunnersView, { notify: () => undefined }),
  );
  assert.doesNotMatch(
    html,
    /\b(?:host|runner)\s+(?:atestado|verificado|sandboxed|enforced)\b/iu,
  );
  const capabilityCopy = Array.from(
    html.matchAll(
      /<article class="is-(?:real|inactive)">([\s\S]*?)<\/article>/gu,
    ),
    (match) => match[1],
  ).join(" ");
  assert.doesNotMatch(
    capabilityCopy,
    /\b(?:atestad\p{L}*|enforced|sandboxed|isolamento garantido|(?<!não )verificad\p{L}*)\b/iu,
  );
  assert.equal(capabilityCardState(html, "Execução one-shot"), "REAL");
  for (const label of ["Sandbox", "Streaming"]) {
    assert.equal(capabilityCardState(html, label), "INATIVO");
  }
});

test("derives every rendered state from server-provided registry facts", () => {
  const serverCapabilities = {
    identity: "roadmap",
    heartbeat: "roadmap",
    leases: "roadmap",
    durableReplay: "roadmap",
    capabilityProfiles: "roadmap",
    execution: "real",
    sandbox: "real",
    streaming: "real",
  } as unknown as RunnerRegistry["capabilities"];
  assert.deepEqual(runnerCapabilityStates(serverCapabilities), {
    identity: "INATIVO",
    heartbeat: "INATIVO",
    leases: "INATIVO",
    durableReplay: "INATIVO",
    capabilityProfiles: "INATIVO",
    execution: "REAL",
    sandbox: "REAL",
    streaming: "REAL",
  });
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
  assert.match(html, /DECLARADO · hostReported · não verificada/);
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
  assert.match(
    setupCommandBlock,
    /npm run local:engine -- --engine <claude_code_cli\|codex_cli> --path <caminho-absoluto>/u,
  );
  assert.doesNotMatch(setupCommandBlock, /npm run runner -- enroll/u);
  assert.match(source, /SEGREDO EXIBIDO UMA ÚNICA VEZ/);
  assert.match(source, /o token bootstrap[\s\S]+nunca entra no comando/i);
  assert.doesNotMatch(source, /npm run runner -- run/u);
  assert.doesNotMatch(source, /trabalho real continua desabilitado/u);
  assert.match(source, /Sem\{" "\}[\s\S]*<code>--run<\/code>/u);
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
