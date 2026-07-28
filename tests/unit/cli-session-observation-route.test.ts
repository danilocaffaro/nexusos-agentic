import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODEL_ID_PATTERN,
  PROVIDER_ID_PATTERN,
} from "../../src/contracts/provider-catalog";
import { CONNECTION_INTENT_SPEC_VERSION } from "../../src/contracts/connection-intent";

const root = fileURLToPath(new URL("../..", import.meta.url));
const routePath = join(
  root,
  "app/api/providers/cli-session-observation/route.ts",
);
const routeSource = await readFile(routePath, "utf8");
const catalogRoutePath = join(root, "app/api/providers/catalog/route.ts");
const catalogRouteSource = await readFile(catalogRoutePath, "utf8");

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
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
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
    [503, "provider_catalog_unavailable"],
  ] as const) {
    assert.match(routeSource, new RegExp(`"${code}"`, "u"));
    assert.match(routeSource, new RegExp(`[, (]${status}[,)]`, "u"));
  }
  assert.doesNotMatch(routeSource, /\bconsole\.|\blog\(|logger/iu);
});

test("body reader enforces the exact byte, media and UTF-8 boundary", () => {
  assert.match(routeSource, /const MAX_BODY_BYTES = 32_768;/u);
  assert.match(routeSource, /request\.body\.getReader\(\)/u);
  assert.doesNotMatch(
    routeSource,
    /error\.code === "cli_session_observation_request_too_large"[\s\S]{0,120}request\.body\.cancel/u,
  );
  assert.match(routeSource, /await request\.body\.cancel\(\)\.catch/u);
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
  assert.match(routeSource, /keys\.length !== 2/u);
  assert.match(routeSource, /keys\[0\] !== "intent"/u);
  assert.match(routeSource, /keys\[1\] !== "runnerId"/u);
  assert.doesNotMatch(
    routeSource.slice(
      routeSource.indexOf("function parseEnvelope("),
      routeSource.indexOf("function publicResolution("),
    ),
    /declaration:/u,
  );
  assert.doesNotMatch(routeSource, /runnerId:\s*value\.runnerId as string/u);
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
  assert.match(routeSource, /declaration:\s*snapshot\.declaration/u);
  assert.match(
    routeSource,
    /"x-nexus-provider-catalog-digest":\s*\n?\s*snapshot\.sourceRef\.declarationSha256/u,
  );
  const source = routeSource.indexOf("const snapshot = await catalogSource()");
  const adapter = routeSource.indexOf(
    "await resolveCliSessionObservationFromD1(",
  );
  assert.equal(source >= 0 && source < adapter, true);
  assert.doesNotMatch(whitelist, /catalogRef|sourceRef|declarationSha256/u);
});

test("the worst valid B2 intent remains comfortably below 32 KiB", () => {
  const providerId = `p${"x".repeat(31)}`;
  const modelId = `@${"_".repeat(255)}`;
  assert.equal(PROVIDER_ID_PATTERN.test(providerId), true);
  assert.equal(MODEL_ID_PATTERN.test(modelId), true);
  const envelope = {
    runnerId: `rnr_${"a".repeat(32)}`,
    intent: {
      specVersion: CONNECTION_INTENT_SPEC_VERSION,
      providerId,
      method: "cli",
      cliEngine: "claude_code_cli",
      modelId,
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  assert.equal(bytes < 32_768, true, `${bytes} bytes`);
});

test("catalog GET orders authority before query, body and source", () => {
  const identity = catalogRouteSource.indexOf(
    "const identity = requireRequestIdentity(request)",
  );
  const membership = catalogRouteSource.indexOf(
    "await requireWorkspaceMember(identity)",
  );
  const query = catalogRouteSource.indexOf("new URL(request.url).search");
  const body = catalogRouteSource.indexOf("request.body !== null");
  const source = catalogRouteSource.indexOf("const snapshot = await source()");
  assert.equal(
    identity >= 0 &&
      identity < membership &&
      membership < query &&
      query < body &&
      body < source,
    true,
  );
});

test("catalog GET exposes only the closed projection view", () => {
  assert.match(
    catalogRouteSource,
    /specVersion:\s*PROVIDER_CATALOG_VIEW_SPEC_VERSION/u,
  );
  assert.match(catalogRouteSource, /catalog:\s*snapshot\.projection/u);
  assert.match(
    catalogRouteSource,
    /declarationSha256:\s*snapshot\.sourceRef\.declarationSha256/u,
  );
  assert.doesNotMatch(catalogRouteSource, /declaration:\s*snapshot/u);
  assert.doesNotMatch(catalogRouteSource, /catalogClaim:\s*["'][^"']+["']/u);
});

test("catalog transport freezes exact methods, errors and private headers", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    assert.match(
      catalogRouteSource,
      new RegExp(`export function ${method}\\(`, "u"),
    );
  }
  for (const [status, code] of [
    [400, "invalid_provider_catalog_request"],
    [401, "authentication_required"],
    [403, "workspace_membership_required"],
    [405, "method_not_allowed"],
    [503, "provider_catalog_unavailable"],
  ] as const) {
    assert.match(catalogRouteSource, new RegExp(`"${code}"`, "u"));
    assert.match(catalogRouteSource, new RegExp(`[, (]${status}[,)]`, "u"));
  }
  assert.match(catalogRouteSource, /new Response\(null,\s*\{\s*status: 405/u);
  assert.match(catalogRouteSource, /allow: "GET"/u);
  assert.match(catalogRouteSource, /"cache-control": "private, no-store"/u);
  assert.match(catalogRouteSource, /"x-content-type-options": "nosniff"/u);
  assert.match(
    catalogRouteSource,
    /Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization/u,
  );
  assert.doesNotMatch(
    catalogRouteSource,
    /access-control-allow-origin|\bconsole\.|\blog\(|logger/iu,
  );
});
