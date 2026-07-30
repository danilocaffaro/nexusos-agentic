import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const port = Number(
  process.env.NEXUS_CLI_SESSION_OBSERVATION_API_TEST_PORT ?? "3944",
);
const directPort = port + 1;
const baseUrl = `http://127.0.0.1:${port}`;
const routeUrl = `${baseUrl}/api/providers/cli-session-observation`;
const catalogRouteUrl = `${baseUrl}/api/providers/catalog`;
const persistPath = mkdtempSync(
  join(tmpdir(), "nexusos-cli-session-observation-api-"),
);
const registryPath = join(persistPath, "miniflare-registry");
const xdgConfigPath = join(persistPath, "xdg");
const wranglerEnvironment = {
  ...process.env,
  MINIFLARE_REGISTRY_PATH: registryPath,
  WRANGLER_LOG_PATH: join(persistPath, "wrangler.log"),
  XDG_CONFIG_HOME: xdgConfigPath,
};
const routePath = resolve(
  root,
  "app/api/providers/cli-session-observation/route.ts",
);
const catalogRoutePath = resolve(root, "app/api/providers/catalog/route.ts");
const catalogSourcePath = resolve(
  root,
  "src/domain/providers/bundled-provider-catalog.ts",
);
const directWorkerPath = join(persistPath, "direct-route-worker.ts");
const directConfigPath = join(persistPath, "direct-route-wrangler.jsonc");
const maxBodyBytes = 32_768;
const privateVary =
  "Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization";
const organizationA = "org-local-aurora";
const ownerA = "principal-local-owner";
const nonmemberA = "principal-cli-observation-nonmember";
const organizationB = "org-cli-observation-other";
const ownerB = "principal-cli-observation-other-owner";
const freshRunnerId = runnerId(1);
const hiddenRunnerId = runnerId(2);
const freshReportId = reportId(1);
const hiddenReportId = reportId(2);
const now = Date.now();
const issuedAt = iso(now - 4 * 86_400_000);
const expiresAt = iso(now + 4 * 86_400_000);
const freshReceivedAt = iso(now - 30_000);
let server;
let serverOutput = "";

mkdirSync(registryPath, { recursive: true });
mkdirSync(xdgConfigPath, { recursive: true });
try {
  assertTransportGuards();
  await command("npx", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
  ]);
  server = spawn(
    "npx",
    ["vinext", "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: root,
      env: {
        ...wranglerEnvironment,
        NEXUS_ALLOW_TEST_IDENTITIES: "1",
        NEXUS_ALLOW_LOCAL_IDENTITY: "0",
        NEXUS_PERSIST_STATE_PATH: persistPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  await healthy();

  const bootstrap = await fetch(`${baseUrl}/api/workspace`, {
    headers: identityHeaders(ownerA, organizationA),
  });
  assert.equal(bootstrap.status, 200);
  await seedAccess();
  await seedRunners();
  await seedReports();

  const nonmemberCatalog = await fetch(`${catalogRouteUrl}?unexpected=1`, {
    headers: identityHeaders(nonmemberA, organizationA),
  });
  await assertError(nonmemberCatalog, 403, "workspace_membership_required");

  const invalidCatalogQuery = await fetch(`${catalogRouteUrl}?unexpected=1`, {
    headers: identityHeaders(ownerA, organizationA),
  });
  await assertError(
    invalidCatalogQuery,
    400,
    "invalid_provider_catalog_request",
  );

  const catalogResponse = await fetch(catalogRouteUrl, {
    headers: identityHeaders(ownerA, organizationA),
  });
  assert.equal(catalogResponse.status, 200);
  assertPrivate(catalogResponse);
  const catalogView = await catalogResponse.json();
  assert.deepEqual(Object.keys(catalogView).sort(), [
    "catalog",
    "sourceRef",
    "specVersion",
  ]);
  assert.deepEqual(Object.keys(catalogView.sourceRef).sort(), [
    "declarationSha256",
    "source",
    "specVersion",
  ]);
  assert.equal(catalogView.specVersion, "nexusos.provider-catalog-view.v1");
  assert.equal(
    catalogView.sourceRef.specVersion,
    "nexusos.bundled-provider-catalog-source.v1",
  );
  assert.equal(catalogView.sourceRef.source, "nexusos_bundled");
  assert.match(catalogView.sourceRef.declarationSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(catalogView.catalog, {
    specVersion: "nexusos.provider-catalog-projection.v1",
    catalogClaim: "declared_only_no_connectivity",
    providers: [
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        methods: [
          {
            method: "cli",
            trust: "declared_unverified",
            cliEngine: "claude_code_cli",
          },
        ],
      },
      {
        providerId: "openai",
        displayName: "OpenAI",
        methods: [
          {
            method: "cli",
            trust: "declared_unverified",
            cliEngine: "codex_cli",
          },
        ],
      },
    ],
    models: [],
  });
  assert.equal("declaration" in catalogView, false);
  const catalogDigest = catalogView.sourceRef.declarationSha256;

  const nonmember = await fetch(`${routeUrl}?unexpected=1`, {
    method: "POST",
    headers: {
      ...identityHeaders(nonmemberA, organizationA),
      "content-type": "text/plain",
    },
    body: "not-json",
  });
  await assertError(nonmember, 403, "workspace_membership_required");

  const unexpectedQuery = await postObservation(validRequest(freshRunnerId), {
    search: "?unexpected=1",
  });
  await assertError(
    unexpectedQuery,
    400,
    "invalid_cli_session_observation_request",
  );

  for (const invalidEnvelope of [
    [],
    {
      runnerId: freshRunnerId,
      intent: validIntent(),
      declaration: validDeclaration(),
    },
    {
      ...validRequest(freshRunnerId),
      unexpected: true,
    },
  ]) {
    const response = await postObservation(invalidEnvelope);
    await assertError(response, 400, "invalid_cli_session_observation_request");
  }

  const unsupportedMedia = await fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/problem+json",
    },
    body: JSON.stringify(validRequest(freshRunnerId)),
  });
  await assertError(unsupportedMedia, 415, "unsupported_media_type");
  const absentMedia = await fetch(routeUrl, {
    method: "POST",
    headers: identityHeaders(ownerA, organizationA),
    body: encoded(validRequest(freshRunnerId)),
  });
  await assertError(absentMedia, 415, "unsupported_media_type");
  const extraMediaParameter = await fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/json; charset=utf-8; profile=test",
    },
    body: JSON.stringify(validRequest(freshRunnerId)),
  });
  await assertError(extraMediaParameter, 415, "unsupported_media_type");

  const invalidUtf8 = await postBytes(Uint8Array.from([0xc3, 0x28]));
  await assertError(
    invalidUtf8,
    400,
    "invalid_cli_session_observation_request",
  );

  const encodedValidRequest = new TextEncoder().encode(
    JSON.stringify(validRequest(freshRunnerId)),
  );
  const bomBody = new Uint8Array(encodedValidRequest.byteLength + 3);
  bomBody.set([0xef, 0xbb, 0xbf]);
  bomBody.set(encodedValidRequest, 3);
  const bom = await postBytes(bomBody);
  await assertError(bom, 400, "invalid_cli_session_observation_request");

  const declaredTooLargeBody = new Uint8Array(maxBodyBytes + 1);
  const declaredTooLarge = await fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/json",
      "content-length": String(declaredTooLargeBody.byteLength),
    },
    body: declaredTooLargeBody,
  });
  await assertError(
    declaredTooLarge,
    413,
    "cli_session_observation_request_too_large",
  );

  const chunkedTooLarge = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(maxBodyBytes));
      controller.enqueue(Uint8Array.of(0x20));
      controller.close();
    },
  });
  const actualTooLarge = await fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/json",
    },
    body: chunkedTooLarge,
    duplex: "half",
  });
  await assertError(
    actualTooLarge,
    413,
    "cli_session_observation_request_too_large",
  );

  const exactCapRequest = exactByteLengthRequest(maxBodyBytes);
  assert.equal(
    new TextEncoder().encode(exactCapRequest).byteLength,
    maxBodyBytes,
  );
  const exactCap = await fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/json",
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(exactCapRequest));
        controller.close();
      },
    }),
    duplex: "half",
  });
  assert.equal(exactCap.status, 200);
  assertPrivate(exactCap);
  assert.equal(
    exactCap.headers.get("x-nexus-provider-catalog-digest"),
    catalogDigest,
  );
  const exactCapBody = await exactCap.json();
  assert.equal(exactCapBody.status, "not_observed");
  assert.equal(exactCapBody.observationClaim, "no_cli_session_observation");

  const contentLengthAbsent = await fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/json",
    },
    body: streamBytes(encoded(validRequest(freshRunnerId))),
    duplex: "half",
  });
  assert.equal(contentLengthAbsent.status, 200);
  assertPrivate(contentLengthAbsent);
  assert.equal(
    contentLengthAbsent.headers.get("x-nexus-provider-catalog-digest"),
    catalogDigest,
  );
  assert.equal((await contentLengthAbsent.json()).status, "observed");

  const observedResponse = await postObservation(validRequest(freshRunnerId), {
    contentType: "application/json; charset=utf-8",
  });
  assert.equal(observedResponse.status, 200);
  assertPrivate(observedResponse);
  assert.equal(
    observedResponse.headers.get("x-nexus-provider-catalog-digest"),
    catalogDigest,
  );
  const observed = await observedResponse.json();
  assert.deepEqual(Object.keys(observed).sort(), [
    "candidate",
    "observation",
    "observationClaim",
    "specVersion",
    "status",
  ]);
  assert.deepEqual(Object.keys(observed.candidate).sort(), [
    "bindingTrust",
    "cliEngine",
    "modelId",
    "providerId",
  ]);
  assert.deepEqual(Object.keys(observed.observation).sort(), [
    "engineVersion",
    "evaluatedAt",
    "freshUntil",
    "receivedAt",
    "reportId",
    "runnerId",
    "trust",
  ]);
  assert.equal(observed.specVersion, "nexusos.cli-session-observation.v1");
  assert.equal(observed.status, "observed");
  assert.equal(
    observed.observationClaim,
    "fresh_host_reported_cli_auth_session_for_declared_candidate_no_provider_connection_no_account_no_execution_no_quota",
  );
  assert.deepEqual(observed.candidate, {
    providerId: "openai",
    modelId: null,
    cliEngine: "codex_cli",
    bindingTrust: "declared_unverified",
  });
  assert.equal(observed.observation.runnerId, freshRunnerId);
  assert.equal(observed.observation.reportId, freshReportId);
  assert.equal(observed.observation.receivedAt, freshReceivedAt);
  assert.equal(observed.observation.engineVersion, "2.1.220");
  assert.equal(observed.observation.trust, "hostReported");

  const hiddenResponse = await postObservation(validRequest(hiddenRunnerId));
  assert.equal(hiddenResponse.status, 200);
  assertPrivate(hiddenResponse);
  assert.deepEqual(await hiddenResponse.json(), {
    specVersion: "nexusos.cli-session-observation.v1",
    status: "not_observed",
    observationClaim: "no_cli_session_observation",
    reason: "runner_not_observed",
  });

  const missingResponse = await postObservation(validRequest(runnerId(999)));
  assert.equal(missingResponse.status, 200);
  assertPrivate(missingResponse);
  assert.deepEqual(await missingResponse.json(), {
    specVersion: "nexusos.cli-session-observation.v1",
    status: "not_observed",
    observationClaim: "no_cli_session_observation",
    reason: "runner_not_observed",
  });

  for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await fetch(routeUrl, {
      method,
      headers: identityHeaders(ownerA, organizationA),
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assertPrivate(response);
    assert.deepEqual(await response.json(), {
      error: "method_not_allowed",
    });
  }

  const head = await fetch(routeUrl, {
    method: "HEAD",
    headers: identityHeaders(ownerA, organizationA),
  });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "POST");
  assertPrivate(head);
  assert.equal(await head.text(), "");

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await fetch(catalogRouteUrl, {
      method,
      headers: identityHeaders(ownerA, organizationA),
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assertPrivate(response);
    assert.deepEqual(await response.json(), {
      error: "method_not_allowed",
    });
  }

  const catalogHead = await fetch(catalogRouteUrl, {
    method: "HEAD",
    headers: identityHeaders(ownerA, organizationA),
  });
  assert.equal(catalogHead.status, 405);
  assert.equal(catalogHead.headers.get("allow"), "GET");
  assertPrivate(catalogHead);
  assert.equal(await catalogHead.text(), "");

  await stopServer();
  writeDirectRouteWorker();
  serverOutput = "";
  server = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      directWorkerPath,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(directPort),
      "--config",
      directConfigPath,
      "--tsconfig",
      resolve(root, "tsconfig.json"),
      "--persist-to",
      persistPath,
      "--log-level",
      "error",
    ],
    {
      cwd: root,
      env: wranglerEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", capture);
  server.stderr.on("data", capture);
  await directHealthy();
  await assertDirectTransportCases();

  process.stdout.write(
    "Provider catalog and CLI session observation API integration passed source authority, digest binding, auth ordering, transport bounds, tenant anti-enumeration and method grammar.\n",
  );
} finally {
  await stopServer();
  rmSync(persistPath, { recursive: true, force: true });
}

function assertTransportGuards() {
  const routeSource = readFileSync(routePath, "utf8");
  const catalogRouteSource = readFileSync(catalogRoutePath, "utf8");
  const identityIndex = routeSource.indexOf("requireRequestIdentity(request)");
  const membershipIndex = routeSource.indexOf(
    "requireWorkspaceMember(identity)",
  );
  const queryIndex = routeSource.indexOf("new URL(request.url).search");
  const mediaIndex = routeSource.indexOf("requireJsonMediaType(");
  const bodyIndex = routeSource.indexOf("readBoundedBody(request)");
  assert.equal(identityIndex >= 0, true);
  assert.equal(membershipIndex > identityIndex, true);
  assert.equal(queryIndex > membershipIndex, true);
  assert.equal(mediaIndex > membershipIndex, true);
  assert.equal(bodyIndex > membershipIndex, true);
  assert.match(routeSource, /const MAX_BODY_BYTES = 32_768;/u);
  assert.match(routeSource, /declaration:\s*snapshot\.declaration/u);
  assert.match(routeSource, /x-nexus-provider-catalog-digest/u);
  assert.match(
    routeSource,
    /IdentityRequiredError[\s\S]*authentication_required/u,
    "the development server forces local identity, so the 401 grammar and ordering are statically gated",
  );
  assert.match(
    routeSource,
    /vary:\s*\n?\s*"Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization"/u,
    "the route must emit the exact private Vary value before framework decoration",
  );
  const contentLengthIndex = routeSource.search(/content-length/iu);
  assert.notEqual(contentLengthIndex, -1, "route must validate Content-Length");
  const transportGuard = routeSource.slice(
    contentLengthIndex,
    contentLengthIndex + 10_000,
  );
  assert.match(
    transportGuard,
    /invalid_cli_session_observation_request/u,
    "invalid or mismatched Content-Length must map to the exact 400 error",
  );
  assert.match(
    transportGuard,
    /cli_session_observation_request_too_large/u,
    "declared or actual overflow must map to the exact 413 error",
  );
  assert.match(
    transportGuard,
    /\.cancel\s*\(/u,
    "actual overflow must cancel the request reader",
  );
  assert.match(
    transportGuard,
    /(?:byteLength|total|actual)[\s\S]{0,240}!={1,2}[\s\S]{0,240}(?:declared|contentLength)|(?:declared|contentLength)[\s\S]{0,240}!={1,2}[\s\S]{0,240}(?:byteLength|total|actual)/u,
    "route must reject a declared/actual Content-Length mismatch",
  );
  const catalogIdentityIndex = catalogRouteSource.indexOf(
    "requireRequestIdentity(request)",
  );
  const catalogMembershipIndex = catalogRouteSource.indexOf(
    "requireWorkspaceMember(identity)",
  );
  const catalogQueryIndex = catalogRouteSource.indexOf(
    "new URL(request.url).search",
  );
  const catalogBodyIndex = catalogRouteSource.indexOf("request.body !== null");
  const catalogSourceIndex = catalogRouteSource.indexOf(
    "const snapshot = await source()",
  );
  assert.equal(catalogIdentityIndex >= 0, true);
  assert.equal(catalogMembershipIndex > catalogIdentityIndex, true);
  assert.equal(catalogQueryIndex > catalogMembershipIndex, true);
  assert.equal(catalogBodyIndex > catalogMembershipIndex, true);
  assert.equal(catalogSourceIndex > catalogBodyIndex, true);
  assert.match(catalogRouteSource, /catalog:\s*snapshot\.projection/u);
  assert.doesNotMatch(catalogRouteSource, /declaration:\s*snapshot/u);
}

function writeDirectRouteWorker() {
  writeFileSync(
    directWorkerPath,
    `import {
  cliSessionObservationRoute,
} from ${JSON.stringify(routePath)};
import {
  providerCatalogRoute,
} from ${JSON.stringify(catalogRoutePath)};
import {
  createBundledProviderCatalogSource,
} from ${JSON.stringify(catalogSourcePath)};

function bytes(value: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

const unavailableSource = createBundledProviderCatalogSource(() => ({
  specVersion: "nexusos.provider-catalog-declaration.v0",
  providers: [],
  models: [],
}));
const genericUnavailableSource = async () => {
  throw new Error("generic catalog source failure");
};

export default {
  async fetch(request: Request): Promise<Response> {
    const control = request.headers.get("x-nexus-direct-case");
    if (control === "health") return new Response("ok");
    if (control === "unauthenticated") {
      return cliSessionObservationRoute({
        url: "https://nexus.invalid/api/providers/cli-session-observation?unexpected=1",
        headers: new Headers({ "content-type": "text/plain" }),
        body: bytes("not-json"),
      } as Request);
    }
    if (control === "unauthenticated-catalog") {
      return providerCatalogRoute({
        url: "https://nexus.invalid/api/providers/catalog?unexpected=1",
        headers: new Headers(),
        body: bytes("not-allowed"),
      } as Request);
    }
    const headers = new Headers(request.headers);
    headers.delete("x-nexus-direct-case");
    if (control === "catalog-body") {
      return providerCatalogRoute({
        url: "http://127.0.0.1/api/providers/catalog",
        headers,
        body: bytes("not-allowed"),
      } as Request);
    }
    if (control === "source-failure-catalog") {
      return providerCatalogRoute({
        url: "http://127.0.0.1/api/providers/catalog",
        headers,
        body: null,
      } as Request, unavailableSource);
    }
    headers.set("content-type", "application/json");
    const raw = await request.text();
    if (
      control === "source-failure-observation" ||
      control === "generic-source-failure-observation"
    ) {
      headers.set(
        "content-length",
        String(new TextEncoder().encode(raw).byteLength),
      );
      return cliSessionObservationRoute({
        url: "http://127.0.0.1/api/providers/cli-session-observation",
        headers,
        body: bytes(raw),
      } as Request, control === "source-failure-observation"
        ? unavailableSource
        : genericUnavailableSource);
    }
    headers.set(
      "content-length",
      control === "invalid-content-length"
        ? "not-a-canonical-length"
        : String(new TextEncoder().encode(raw).byteLength + 1),
    );
    return cliSessionObservationRoute({
      url: "http://127.0.0.1/api/providers/cli-session-observation",
      headers,
      body: bytes(raw),
    } as Request);
  },
};
`,
    "utf8",
  );
  writeFileSync(
    directConfigPath,
    `${JSON.stringify(
      {
        name: "nexusos-cli-session-observation-direct-route-test",
        main: directWorkerPath,
        compatibility_date: "2026-07-25",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          NEXUS_ALLOW_LOCAL_IDENTITY: "0",
          NEXUS_ALLOW_TEST_IDENTITIES: "1",
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "nexusos-cli-session-observation-direct-route-test",
            database_id: "00000000-0000-4000-8000-000000000000",
            migrations_dir: resolve(root, "drizzle"),
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function assertDirectTransportCases() {
  const directUrl = `http://127.0.0.1:${directPort}`;
  const unauthenticated = await fetch(directUrl, {
    headers: { "x-nexus-direct-case": "unauthenticated" },
  });
  await assertExactError(unauthenticated, 401, "authentication_required");

  const unauthenticatedCatalog = await fetch(directUrl, {
    headers: { "x-nexus-direct-case": "unauthenticated-catalog" },
  });
  await assertExactError(
    unauthenticatedCatalog,
    401,
    "authentication_required",
  );

  const catalogBody = await fetch(directUrl, {
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "x-nexus-direct-case": "catalog-body",
    },
  });
  await assertExactError(catalogBody, 400, "invalid_provider_catalog_request");

  for (const [control, expectedStatus] of [
    ["invalid-content-length", 400],
    ["mismatched-content-length", 400],
  ]) {
    const response = await fetch(directUrl, {
      method: "POST",
      headers: {
        ...identityHeaders(ownerA, organizationA),
        "x-nexus-direct-case": control,
        "content-type": "application/json",
      },
      body: JSON.stringify(validRequest(freshRunnerId)),
    });
    await assertExactError(
      response,
      expectedStatus,
      "invalid_cli_session_observation_request",
    );
  }

  for (const [control, body] of [
    ["source-failure-catalog", undefined],
    ["source-failure-observation", JSON.stringify(validRequest(freshRunnerId))],
    [
      "generic-source-failure-observation",
      JSON.stringify(validRequest(freshRunnerId)),
    ],
  ]) {
    const response = await fetch(directUrl, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...identityHeaders(ownerA, organizationA),
        "x-nexus-direct-case": control,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
    await assertExactError(response, 503, "provider_catalog_unavailable");
    assert.equal(
      response.headers.has("x-nexus-provider-catalog-digest"),
      false,
      "source failure must not bind an unavailable catalog digest",
    );
  }
}

async function seedAccess() {
  await sql(
    `INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES (
       '${nonmemberA}', '${organizationA}', 'human',
       'CLI observation nonmember'
     );
     INSERT INTO organizations (id, slug, name)
     VALUES (
       '${organizationB}', 'cli-observation-other',
       'CLI observation other'
     );
     INSERT INTO principals (id, organization_id, kind, display_name)
     VALUES (
       '${ownerB}', '${organizationB}', 'human',
       'CLI observation other owner'
     );
     INSERT INTO memberships (id, organization_id, principal_id, role)
     VALUES (
       'membership-cli-observation-other-owner', '${organizationB}',
       '${ownerB}', 'owner'
     );`,
  );
}

async function seedRunners() {
  await sql(
    `${runnerInsert({
      index: 1,
      organizationId: organizationA,
      ownerId: ownerA,
      selectedRunnerId: freshRunnerId,
    })}
     ${runnerInsert({
       index: 2,
       organizationId: organizationB,
       ownerId: ownerB,
       selectedRunnerId: hiddenRunnerId,
     })}`,
  );
}

async function seedReports() {
  await sql(
    `${reportInsert({
      organizationId: organizationA,
      selectedRunnerId: freshRunnerId,
      selectedReportId: freshReportId,
      version: "2.1.220",
    })}
     ${reportInsert({
       organizationId: organizationB,
       selectedRunnerId: hiddenRunnerId,
       selectedReportId: hiddenReportId,
       version: "2.1.221",
     })}`,
  );
}

function runnerInsert({ index, organizationId, ownerId, selectedRunnerId }) {
  const principalId = `principal-cli-observation-runner-${index}`;
  const tokenId = `token-cli-observation-${index}`;
  const tokenHash = index.toString(16).padStart(64, "0");
  const publicKey = `A${index.toString(16).padStart(42, "0")}`;
  const enrolledAt = iso(now - 200_000_000 - index * 1_000);
  return `INSERT INTO principals (
    id, organization_id, kind, external_id, display_name
  ) VALUES (
    '${principalId}', '${organizationId}', 'runner', '${selectedRunnerId}',
    'CLI observation runner ${index}'
  );
  INSERT INTO runner_enrollment_tokens (
    id, organization_id, token_hash, issued_by, display_name,
    issued_at, expires_at
  ) VALUES (
    '${tokenId}', '${organizationId}', '${tokenHash}', '${ownerId}',
    'CLI observation runner ${index}', '${issuedAt}', '${expiresAt}'
  );
  INSERT INTO runners (
    id, organization_id, principal_id, enrollment_token_id,
    display_name, public_key, enrolled_at
  ) VALUES (
    '${selectedRunnerId}', '${organizationId}', '${principalId}', '${tokenId}',
    'CLI observation runner ${index}', '${publicKey}', '${enrolledAt}'
  );`;
}

function reportInsert({
  organizationId,
  selectedRunnerId,
  selectedReportId,
  version,
}) {
  return `INSERT INTO runner_engine_reports (
    organization_id, runner_id, report_id, request_hash, declaration_hash,
    schema_version, collected_at, received_at, truncated, response_status,
    response_body, replay_count
  ) VALUES (
    '${organizationId}', '${selectedRunnerId}', '${selectedReportId}',
    '${"a".repeat(64)}', '${"b".repeat(64)}', 1, '${freshReceivedAt}',
    '${freshReceivedAt}', 0, 201, '{}', 0
  );
  INSERT INTO runner_engine_evidence (
    runner_id, report_id, position, engine, status, readiness, reason, version
  ) VALUES (
    '${selectedRunnerId}', '${selectedReportId}', 0, 'claude_code_cli',
    'available', 'ready', 'none', '${version}'
  );
  INSERT INTO runner_engine_evidence (
    runner_id, report_id, position, engine, status, readiness, reason, version
  ) VALUES (
    '${selectedRunnerId}', '${selectedReportId}', 1, 'codex_cli',
    'available', 'ready', 'none', '${version}'
  );`;
}

function validRequest(selectedRunnerId) {
  return {
    runnerId: selectedRunnerId,
    intent: validIntent(),
  };
}

function validIntent() {
  return {
    specVersion: "nexusos.connection-intent.v1",
    providerId: "openai",
    method: "cli",
    cliEngine: "codex_cli",
    modelId: null,
  };
}

function validDeclaration() {
  return {
    specVersion: "nexusos.provider-catalog-declaration.v1",
    providers: [
      {
        providerId: "openai",
        displayName: "OpenAI",
        methods: [{ method: "cli", cliEngine: "codex_cli" }],
      },
    ],
    models: [
      {
        providerId: "openai",
        modelId: "gpt-5.6",
        displayName: "GPT 5.6",
        lifecycle: "available",
      },
    ],
  };
}

function exactByteLengthRequest(targetBytes) {
  const request = {
    runnerId: freshRunnerId,
    intent: "",
  };
  const empty = JSON.stringify(request);
  const paddingLength =
    targetBytes - new TextEncoder().encode(empty).byteLength;
  assert.equal(paddingLength >= 0, true);
  request.intent = "a".repeat(paddingLength);
  return JSON.stringify(request);
}

function encoded(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function streamBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function postObservation(
  value,
  { search = "", contentType = "application/json" } = {},
) {
  return fetch(`${routeUrl}${search}`, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": contentType,
    },
    body: JSON.stringify(value),
  });
}

function postBytes(bytes) {
  return fetch(routeUrl, {
    method: "POST",
    headers: {
      ...identityHeaders(ownerA, organizationA),
      "content-type": "application/json",
    },
    body: bytes,
  });
}

function identityHeaders(principalId, organizationId) {
  return {
    "x-nexus-test-principal": principalId,
    "x-nexus-test-organization": organizationId,
  };
}

async function assertError(response, status, error) {
  assert.equal(response.status, status);
  assertPrivate(response);
  assert.deepEqual(await response.json(), { error });
}

async function assertExactError(response, status, error) {
  assert.equal(response.status, status);
  assertPrivateExact(response);
  assert.deepEqual(await response.json(), { error });
}

function assertPrivate(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(
    response.headers.get("vary")?.split(", ").slice(0, 4),
    privateVary.split(", "),
  );
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

function assertPrivateExact(response) {
  assertPrivate(response);
  assert.equal(response.headers.get("vary"), privateVary);
}

async function healthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) return;
    } catch {
      // Expected while the development server starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Server startup timed out.\n${serverOutput}`);
}

async function directHealthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Direct route Worker exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${directPort}`, {
        headers: { "x-nexus-direct-case": "health" },
      });
      if (response.ok) return;
    } catch {
      // Expected while the temporary direct route Worker starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Direct route Worker startup timed out.\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.killed) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  server = undefined;
}

function capture(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-40_000);
}

function sql(statement) {
  return command("npx", [
    "wrangler",
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    persistPath,
    "--command",
    statement,
  ]);
}

function command(executable, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: wranglerEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      if (code === 0) resolveCommand(output);
      else {
        rejectCommand(new Error(`${executable} failed (${code}):\n${output}`));
      }
    });
  });
}

function runnerId(index) {
  return `rnr_${index.toString(16).padStart(32, "0")}`;
}

function reportId(index) {
  return `egr_${index.toString(16).padStart(32, "0")}`;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}
