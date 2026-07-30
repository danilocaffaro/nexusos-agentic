import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PROVIDER_CATALOG_VIEW_SPEC_VERSION,
} from "../../src/contracts/provider-catalog-source";
import { getBundledProviderCatalog } from "../../src/domain/providers/bundled-provider-catalog";
import {
  PROVIDER_VIEW_COPY,
  ProvidersView,
  loadProviderCatalog,
  providerCatalogStateForResponse,
} from "../../app/providers-view";
import {
  PROVIDER_DETAIL_COPY,
  PROVIDER_STATUS_COPY,
  ProviderRequestCoordinator,
  providerCopyIsTruthful,
} from "../../app/providers-view-model";

test("maps real catalog transport outcomes into the closed visible states", async () => {
  const snapshot = await getBundledProviderCatalog();
  const declared = await providerCatalogStateForResponse(
    Response.json({
      specVersion: PROVIDER_CATALOG_VIEW_SPEC_VERSION,
      sourceRef: snapshot.sourceRef,
      catalog: snapshot.projection,
    }),
  );
  assert.equal(declared.status, "declared");
  if (declared.status === "declared") {
    assert.deepEqual(
      declared.catalog.providers.map((provider) => provider.providerId),
      ["anthropic", "openai"],
    );
    assert.equal(declared.catalog.providers.every(
      (provider) => provider.models.length === 0,
    ), true);
    assert.match(declared.catalog.sourceRef.declarationSha256, /^[0-9a-f]{64}$/u);
  }

  for (const [status, expected] of [
    [401, "authenticationRequired"],
    [403, "membershipRequired"],
    [400, "unavailable"],
    [503, "unavailable"],
  ] as const) {
    const state = await providerCatalogStateForResponse(
      Response.json({ error: "closed" }, { status }),
    );
    assert.equal(state.status, expected);
  }
  assert.equal(
    (await providerCatalogStateForResponse(Response.json({ forged: true }))).status,
    "unavailable",
  );
});

test("wires supersession and unmount aborts through the visible loader", async () => {
  const snapshot = await getBundledProviderCatalog();
  const response = () => Response.json({
    specVersion: PROVIDER_CATALOG_VIEW_SPEC_VERSION,
    sourceRef: snapshot.sourceRef,
    catalog: snapshot.projection,
  });
  const coordinator = new ProviderRequestCoordinator();
  const requests: Array<{
    resolve: (value: Response) => void;
    signal: AbortSignal;
  }> = [];
  const updates: string[] = [];
  const request = (_input: string, init: RequestInit) =>
    new Promise<Response>((resolve) => {
      assert.ok(init.signal);
      requests.push({ resolve, signal: init.signal });
    });
  const update = (state: { status: string }) => updates.push(state.status);

  const stale = loadProviderCatalog(coordinator, request, update);
  const current = loadProviderCatalog(coordinator, request, update);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(response());
  requests[1].resolve(response());
  await Promise.all([stale, current]);
  assert.deepEqual(updates, ["loading", "loading", "declared"]);

  updates.length = 0;
  const unmounted = loadProviderCatalog(coordinator, request, update);
  coordinator.abortAll();
  requests[2].resolve(response());
  await unmounted;
  assert.deepEqual(updates, ["loading"]);
});

test("renders an honest loading boundary before the real request settles", () => {
  const html = renderToStaticMarkup(createElement(ProvidersView));
  assert.match(html, /data-state="loading"/u);
  assert.match(html, /aria-busy="true"/u);
  assert.match(html, /aria-atomic="true"[^>]*role="status"/u);
  assert.match(html, new RegExp(PROVIDER_STATUS_COPY.loading, "u"));
  assert.match(html, new RegExp(PROVIDER_DETAIL_COPY.loading, "u"));
  assert.match(html, new RegExp(PROVIDER_VIEW_COPY.title, "u"));
  assert.doesNotMatch(html, /DECLARADO · NÃO VERIFICADO/u);
});

test("keeps every new visible copy inside the B6a1 truth guard", () => {
  for (const copy of Object.values(PROVIDER_VIEW_COPY)) {
    assert.equal(providerCopyIsTruthful(copy, "detail"), true, copy);
  }
});

test("atomically removes the provider demo and mounts only the real view", () => {
  const page = readFileSync(
    new URL("../../app/page.tsx", import.meta.url),
    "utf8",
  );
  const view = readFileSync(
    new URL("../../app/providers-view.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /import \{ ProvidersView \} from "\.\/providers-view";/u);
  assert.match(page, /view === "providers"\) return <ProvidersView \/>/u);
  assert.doesNotMatch(page, /\bconst providers\s*=/u);
  assert.doesNotMatch(page, /\bfunction ProvidersView\s*\(/u);

  for (const literal of [
    "Conta de Rafael · 4 agents",
    "Workspace Aurora · 2 agents",
    "heartbeat 12s",
    "heartbeat 7s",
    "Gerenciar conexão",
    "Reauth",
    "Nova conexão",
    "Provedores & sessões",
    "OAuth ou CLI autenticada",
  ]) {
    assert.equal(page.includes(literal), false, literal);
  }
  assert.doesNotMatch(view, /\b(?:Conectado|Saudável)\b/u);
});

test("uses one no-store catalog transport and no observation or periodic effect", () => {
  const source = readFileSync(
    new URL("../../app/providers-view.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.match(/\bfetch\b/gu)?.length, 1);
  assert.match(source, /loadProviderCatalog\(coordinator, fetch, setState\)/u);
  assert.match(source, /request\("\/api\/providers\/catalog"/u);
  assert.match(source, /cache: "no-store"/u);
  assert.match(source, /coordinator\.begin\("catalog"\)/u);
  assert.match(source, /coordinator\.finish\("catalog", ticket\.epoch\)/u);
  assert.match(source, /abortAll\(\)/u);
  assert.doesNotMatch(
    source,
    /(?:cli-session-observation|catalogDigestMatches|setInterval|setTimeout|WebSocket|EventSource|child_process|process\.env|credential|secret|api.?key|access.?token|refresh.?token)/iu,
  );
  assert.match(
    source,
    /role=\{state === "loading" \? "status" : "alert"\}/u,
  );
  assert.match(source, /key=\{state\}/u);
  assert.match(source, /retryButtonRef\.current\?\.focus\(\)/u);
});
