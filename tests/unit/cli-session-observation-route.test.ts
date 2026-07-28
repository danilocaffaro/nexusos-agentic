import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CATALOG_DISPLAY_NAME_MAX_CHARS,
  CONNECTION_METHODS,
  PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
  PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  PROVIDER_CATALOG_MAX_PROVIDERS,
} from "../../src/contracts/provider-catalog";
import { CONNECTION_INTENT_SPEC_VERSION } from "../../src/contracts/connection-intent";
import { evaluateProviderCatalog } from "../../src/domain/providers/provider-catalog";

const root = fileURLToPath(new URL("../..", import.meta.url));
const routePath = join(
  root,
  "app/api/providers/cli-session-observation/route.ts",
);
const routeSource = await readFile(routePath, "utf8");

test("auth and membership precede every untrusted request observation", () => {
  const identity = routeSource.indexOf(
    "const identity = requireRequestIdentity(request)",
  );
  const membership = routeSource.indexOf(
    "await requireWorkspaceMember(identity)",
  );
  const query = routeSource.indexOf("new URL(request.url).search");
  const media = routeSource.indexOf(
    'requireJsonMediaType(request.headers.get("content-type"))',
  );
  const body = routeSource.indexOf("await readBoundedBody(request)");
  assert.equal(
    identity >= 0 &&
      identity < membership &&
      membership < query &&
      query < media &&
      media < body,
    true,
  );
});

test("the transport is POST-only with exact private response policy", () => {
  for (const method of [
    "GET",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD",
  ]) {
    assert.match(routeSource, new RegExp(`export function ${method}\\(`, "u"));
  }
  assert.match(routeSource, /new Response\(null,\s*\{\s*status: 405/gu);
  assert.match(routeSource, /\{ error: "method_not_allowed" \}/gu);
  assert.match(routeSource, /allow: "POST"/gu);
  assert.match(routeSource, /"cache-control": "private, no-store"/gu);
  assert.match(routeSource, /"x-content-type-options": "nosniff"/gu);
  assert.match(
    routeSource,
    /Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization/gu,
  );
  assert.doesNotMatch(routeSource, /access-control-allow-origin/iu);
});

test("the route freezes exact error grammar without logging", () => {
  for (const [status, code] of [
    [400, "invalid_cli_session_observation_request"],
    [401, "authentication_required"],
    [403, "workspace_membership_required"],
    [405, "method_not_allowed"],
    [413, "cli_session_observation_request_too_large"],
    [415, "unsupported_media_type"],
    [500, "cli_session_observation_failed"],
  ] as const) {
    assert.match(routeSource, new RegExp(`"${code}"`, "u"));
    assert.match(routeSource, new RegExp(`[, (]${status}[,)]`, "u"));
  }
  assert.doesNotMatch(routeSource, /\bconsole\.|\blog\(|logger/iu);
});

test("body reader enforces the exact byte, media and UTF-8 boundary", () => {
  assert.match(routeSource, /const MAX_BODY_BYTES = 4_194_304;/u);
  assert.match(routeSource, /request\.body\.getReader\(\)/u);
  assert.match(routeSource, /await reader\.cancel\(\)\.catch/u);
  assert.match(routeSource, /reader\.releaseLock\(\)/u);
  assert.match(routeSource, /declaredLength !== total/u);
  assert.match(routeSource, /if \(value === null\) return undefined;/u);
  assert.match(routeSource, /fatal: true/u);
  assert.match(routeSource, /ignoreBOM: true/u);
  assert.match(routeSource, /hasUtf8Bom\(raw\)/u);
  assert.match(routeSource, /application\/json/u);
  assert.match(routeSource, /charset\\s\*=\\s\*utf-8/u);
  assert.doesNotMatch(routeSource, /request\.(?:json|arrayBuffer)\(/u);
});

test("the parsed envelope and emitted resolution are exact whitelists", () => {
  assert.match(routeSource, /keys\.length !== 3/u);
  assert.match(routeSource, /keys\[0\] !== "declaration"/u);
  assert.match(routeSource, /keys\[1\] !== "intent"/u);
  assert.match(routeSource, /keys\[2\] !== "runnerId"/u);
  const whitelist = routeSource.slice(
    routeSource.indexOf("function publicResolution("),
    routeSource.indexOf("function routeError("),
  );
  assert.doesNotMatch(whitelist, /\.\.\./u);
  for (const field of [
    "specVersion",
    "status",
    "observationClaim",
    "candidate",
    "providerId",
    "modelId",
    "cliEngine",
    "bindingTrust",
    "observation",
    "runnerId",
    "reportId",
    "receivedAt",
    "freshUntil",
    "evaluatedAt",
    "engineVersion",
    "trust",
    "reason",
    "intentReason",
    "catalogReason",
  ]) {
    assert.match(whitelist, new RegExp(`${field}:`, "u"));
  }
});

test("the worst valid semantic envelope remains comfortably below 4 MiB", () => {
  const providers = Array.from(
    { length: PROVIDER_CATALOG_MAX_PROVIDERS },
    (_, providerIndex) => {
      const providerId = `p${providerIndex.toString().padStart(2, "0")}`;
      return {
        providerId,
        displayName: "🧭".repeat(CATALOG_DISPLAY_NAME_MAX_CHARS),
        methods: CONNECTION_METHODS.map((method) => ({
          method,
          cliEngine: method === "cli" ? "codex_cli" : null,
        })),
      };
    },
  );
  const models = providers.flatMap(({ providerId }, providerIndex) =>
    Array.from(
      { length: PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER },
      (_, modelIndex) => {
        const prefix = `m${providerIndex}_${modelIndex}_`;
        return {
          providerId,
          modelId: `${prefix}${"x".repeat(256 - prefix.length)}`,
          displayName: "🧭".repeat(CATALOG_DISPLAY_NAME_MAX_CHARS),
          lifecycle: "available",
        };
      },
    ),
  );
  const declaration = {
    specVersion: PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
    providers,
    models,
  };
  assert.equal(evaluateProviderCatalog(declaration).status, "accepted");
  const envelope = {
    runnerId: `rnr_${"a".repeat(32)}`,
    intent: {
      specVersion: CONNECTION_INTENT_SPEC_VERSION,
      providerId: providers[0]!.providerId,
      method: "cli",
      cliEngine: "codex_cli",
      modelId: models[0]!.modelId,
    },
    declaration,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  assert.equal(bytes < 4_194_304, true, `${bytes} bytes`);
});
