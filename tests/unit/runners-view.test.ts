import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunnersView,
  runnerError,
  shellQuote,
} from "../../app/runners-view";

test("labels runner identity, diagnostic leases and deferred execution truthfully", () => {
  const html = renderToStaticMarkup(
    createElement(RunnersView, { notify: () => undefined }),
  );
  assert.match(html, /RUNNER CONTROL PLANE · REAL · S6\.B2/);
  assert.match(html, /Identidade/);
  assert.match(html, /Heartbeat/);
  assert.match(html, /Lease/);
  assert.match(html, /Replay/);
  assert.match(html, /Execução/);
  assert.match(html, /Sandbox/);
  assert.match(html, /Streaming/);
  assert.match(html, /Online não significa sandboxed/);
  assert.match(html, /Anyone holding the private key can act as this runner/);
  assert.match(html, /Sem shell ou tools nesta versão/);
  assert.match(html, /FENCED DIAGNOSTIC · S6\.B2/);
  assert.match(html, /Não abre shell nem provider CLI/);
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
