import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  createGitHubInstallationDiscoveryTransport,
} from "../../src/adapters/github/github-installation-discovery";
import type {
  GitHubInstallationDiscoveryRuntime,
} from "../../src/adapters/github/github-installation-discovery";
import {
  GITHUB_INSTALLATION_DISCOVERY_API_VERSION,
  GITHUB_INSTALLATION_DISCOVERY_MAX_HTTP_CALLS,
  GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES,
  GITHUB_INSTALLATION_DISCOVERY_REQUEST_TIMEOUT_MS,
  GITHUB_INSTALLATION_DISCOVERY_TOTAL_TIMEOUT_MS,
  GITHUB_INSTALLATION_DISCOVERY_USER_AGENT,
  GitHubInstallationDiscoveryError,
} from "../../src/contracts/github-installation-discovery";
import type {
  GitHubInstallationDiscoveryCredentialLease,
  GitHubInstallationDiscoveryErrorCode,
  GitHubInstallationDiscoveryHttpObservation,
} from "../../src/contracts/github-installation-discovery";
import type {
  GitHubInstallationSnapshotTransport,
} from "../../src/contracts/github-installation-snapshot";
import {
  createGitHubInstallationSnapshotSource,
} from "../../src/domain/github/github-installation-snapshot";

const installationId = "12345678";
const appSecret = "app.jwt.canary";
const installationSecret = "ghs_installation_canary";
const providerUpdatedAt = "2026-07-28T10:00:00.000Z";

type Repository = ReturnType<typeof repository>;

type ProviderOptions = Readonly<{
  repositories?: readonly Repository[];
  metadata?: Record<string, unknown>;
  finalMetadata?: Record<string, unknown>;
  metadataStatus?: number;
  repositoryStatus?: number;
  responseHeaders?: Readonly<Record<string, string>>;
  page?: (
    page: number,
    repositories: readonly Repository[],
  ) => Record<string, unknown>;
}>;

type RequestEvidence = Readonly<{
  authorization: string | null;
  method: string;
  redirect: RequestRedirect;
  url: string;
  userAgent: string | null;
  accept: string | null;
  apiVersion: string | null;
}>;

type Leases = Readonly<{
  appJwt: GitHubInstallationDiscoveryCredentialLease;
  installationToken: GitHubInstallationDiscoveryCredentialLease;
  reveals: { app: number; installation: number };
  releases: { app: number; installation: number };
}>;

test("discovery vocabulary locks the real-provider resource bounds", () => {
  assert.equal(GITHUB_INSTALLATION_DISCOVERY_API_VERSION, "2026-03-10");
  assert.equal(
    GITHUB_INSTALLATION_DISCOVERY_USER_AGENT,
    "NexusOS-GitHub-Installation-Discovery/1",
  );
  assert.equal(GITHUB_INSTALLATION_DISCOVERY_MAX_HTTP_CALLS, 7);
  assert.equal(GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES, 2_097_152);
  assert.equal(GITHUB_INSTALLATION_DISCOVERY_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(GITHUB_INSTALLATION_DISCOVERY_TOTAL_TIMEOUT_MS, 45_000);
});

test("0, 1, 100, 101 and 500 repositories converge in exactly 3..7 GETs", async () => {
  for (const count of [0, 1, 100, 101, 500]) {
    await withProvider(
      { repositories: Array.from({ length: count }, (_, index) => repository(index)) },
      async (provider) => {
        const source = await createGitHubInstallationSnapshotSource(
          provider.transport,
        );
        assert.ok(source, `source for ${count}`);
        assert.equal(
          provider.requests.length,
          2 + Math.max(1, Math.ceil(count / 100)),
        );
        assert.equal(provider.requests.at(0)?.url,
          `https://api.github.com/app/installations/${installationId}`);
        assert.equal(provider.requests.at(-1)?.url,
          `https://api.github.com/app/installations/${installationId}`);
        assert.deepEqual(provider.leases.reveals, {
          app: 1,
          installation: 1,
        });
        assert.deepEqual(provider.leases.releases, {
          app: 1,
          installation: 1,
        });
        if (count > 0) {
          assert.equal(
            (await source.readScope({
              installationId,
              repositoryId: String(10_000 + count - 1),
            }))?.repository.name,
            `repo-${count - 1}`,
          );
        }
        assert.equal(
          await source.readScope({
            installationId,
            repositoryId: "999999999",
          }),
          undefined,
        );
      },
    );
  }
});

test("requests bind each lease to its exact method, origin, path and headers", async () => {
  await withProvider(
    { repositories: Array.from({ length: 101 }, (_, index) => repository(index)) },
    async (provider) => {
      const source = await createGitHubInstallationSnapshotSource(
        provider.transport,
      );
      assert.ok(source);
      assert.deepEqual(
        provider.requests.map((request) => request.authorization),
        [
          `Bearer ${appSecret}`,
          `Bearer ${installationSecret}`,
          `Bearer ${installationSecret}`,
          `Bearer ${appSecret}`,
        ],
      );
      assert.deepEqual(
        provider.requests.map((request) => request.url),
        [
          `https://api.github.com/app/installations/${installationId}`,
          "https://api.github.com/installation/repositories?per_page=100&page=1",
          "https://api.github.com/installation/repositories?per_page=100&page=2",
          `https://api.github.com/app/installations/${installationId}`,
        ],
      );
      for (const request of provider.requests) {
        assert.equal(request.method, "GET");
        assert.equal(request.redirect, "error");
        assert.equal(request.accept, "application/vnd.github+json");
        assert.equal(request.apiVersion, "2026-03-10");
        assert.equal(
          request.userAgent,
          "NexusOS-GitHub-Installation-Discovery/1",
        );
      }
      assert.equal(provider.observations.length, 4);
      assert.ok(
        provider.observations.every(
          (observation) => JSON.stringify(observation).includes(appSecret) === false,
        ),
      );
    },
  );
});

test("B5 owns an exact cursor sequence and rejects replay before another fetch", async () => {
  await withProvider(
    { repositories: Array.from({ length: 101 }, (_, index) => repository(index)) },
    async (provider) => {
      const first = await provider.transport.readPage({
        pageIndex: 0,
        cursor: null,
      }) as Record<string, unknown>;
      assert.equal(first.nextCursor, "github-rest-page:2");
      assert.equal(provider.requests.length, 2);
      await assert.rejects(
        provider.transport.readPage({
          pageIndex: 1,
          cursor: "attacker-controlled",
        }),
        discoveryError("sequence_violation"),
      );
      assert.equal(provider.requests.length, 2);
      assert.deepEqual(provider.leases.releases, {
        app: 1,
        installation: 1,
      });
      await assert.rejects(
        provider.transport.readPage({
          pageIndex: 1,
          cursor: "github-rest-page:2",
        }),
        discoveryError("sequence_violation"),
      );
      assert.deepEqual(provider.leases.releases, {
        app: 1,
        installation: 1,
      });
    },
  );
});

test("overflow, total drift and short pages fail without truncation or retry", async () => {
  await withProvider(
    {
      repositories: Array.from({ length: 100 }, (_, index) => repository(index)),
      page: () => ({
        total_count: 501,
        repositories: Array.from({ length: 100 }, (_, index) => repository(index)),
      }),
    },
    async (provider) => {
      await assert.rejects(
        provider.transport.readPage({ pageIndex: 0, cursor: null }),
        discoveryError("repository_overflow"),
      );
      assert.equal(provider.requests.length, 2);
    },
  );

  await withProvider(
    {
      repositories: Array.from({ length: 101 }, (_, index) => repository(index)),
      page: (page, repositories) => ({
        total_count: page === 1 ? 101 : 100,
        repositories: repositories.slice((page - 1) * 100, page * 100),
      }),
    },
    async (provider) => {
      const first = await provider.transport.readPage({
        pageIndex: 0,
        cursor: null,
      }) as Record<string, unknown>;
      await assert.rejects(
        provider.transport.readPage({
          pageIndex: 1,
          cursor: first.nextCursor as string,
        }),
        discoveryError("total_count_drift"),
      );
      assert.equal(provider.requests.length, 3);
    },
  );

  await withProvider(
    {
      repositories: Array.from({ length: 101 }, (_, index) => repository(index)),
      page: (page, repositories) => ({
        total_count: 101,
        repositories: page === 1
          ? repositories.slice(0, 99)
          : repositories.slice(100),
      }),
    },
    async (provider) => {
      await assert.rejects(
        provider.transport.readPage({ pageIndex: 0, cursor: null }),
        discoveryError("page_length_mismatch"),
      );
      assert.equal(provider.requests.length, 2);
    },
  );
});

test("duplicate IDs and normalized owner/name labels fail closed", async () => {
  for (const duplicated of [
    [
      repository(0),
      { ...repository(1), id: repository(0).id },
    ],
    [
      repository(0),
      {
        ...repository(1),
        name: "REPO-0",
        full_name: "NEXUS-OS/REPO-0",
      },
    ],
  ]) {
    await withProvider(
      { repositories: duplicated },
      async (provider) => {
        await assert.rejects(
          provider.transport.readPage({ pageIndex: 0, cursor: null }),
          discoveryError("duplicate_repository"),
        );
        assert.equal(provider.requests.length, 2);
      },
    );
  }
});

test("metadata fence rejects state, selection, permission, revision and ETag drift", async () => {
  const base = metadata();
  for (const finalMetadata of [
    { ...base, repository_selection: "all" },
    { ...base, permissions: { metadata: "read", issues: "read" } },
    { ...base, updated_at: "2026-07-28T10:01:00.000Z" },
  ]) {
    await withProvider(
      {
        repositories: [repository(0)],
        finalMetadata,
      },
      async (provider) => {
        await assert.rejects(
          provider.transport.readPage({ pageIndex: 0, cursor: null }),
          discoveryError("metadata_drift"),
        );
        assert.equal(provider.requests.length, 3);
      },
    );
  }

  await withProvider(
    { repositories: [repository(0)] },
    async (provider) => {
      provider.setFinalEtag("\"installation-v2\"");
      await assert.rejects(
        provider.transport.readPage({ pageIndex: 0, cursor: null }),
        discoveryError("metadata_drift"),
      );
      assert.equal(provider.requests.length, 3);
    },
  );
});

test("suspension and unsupported or missing permissions never fabricate membership", async () => {
  for (const [providerMetadata, code] of [
    [
      metadata({ suspended_at: "2026-07-28T10:00:01.000Z" }),
      "installation_suspended",
    ],
    [
      metadata({ permissions: { issues: "write" } }),
      "missing_metadata_read",
    ],
    [
      metadata({ permissions: { metadata: "write" } }),
      "missing_metadata_read",
    ],
    [
      metadata({
        permissions: {
          metadata: "read",
          administration: "write",
        },
      }),
      "unsupported_permission",
    ],
    [
      metadata({ permissions: { metadata: "read", issues: "admin" } }),
      "unsupported_permission",
    ],
  ] as const) {
    await withProvider(
      { metadata: providerMetadata },
      async (provider) => {
        await assert.rejects(
          provider.transport.readPage({ pageIndex: 0, cursor: null }),
          discoveryError(code),
        );
        assert.equal(provider.requests.length, 1);
      },
    );
  }
});

test("provider IDs, repository labels and JSON shape are strictly normalized", async () => {
  for (const invalidRepository of [
    { ...repository(0), id: 1.5 },
    { ...repository(0), id: Number.MAX_SAFE_INTEGER + 1 },
    { ...repository(0), name: "..", full_name: "nexus-os/.." },
    { ...repository(0), owner: { login: "bad owner" }, full_name: "bad owner/repo-0" },
    { ...repository(0), full_name: "attacker/repo-0" },
  ]) {
    await withProvider(
      { repositories: [invalidRepository] as Repository[] },
      async (provider) => {
        await assert.rejects(
          provider.transport.readPage({ pageIndex: 0, cursor: null }),
          discoveryError("malformed_response"),
        );
      },
    );
  }
});

test("credential shape, binding, expiry, reveal and release are fail-closed and redacted", async () => {
  const leases = createLeases();
  assert.throws(
    () => createGitHubInstallationDiscoveryTransport({
      installationId,
      appJwt: { ...leases.appJwt, kind: "installation-token" },
      installationToken: leases.installationToken,
    }),
    discoveryError("lease_kind_mismatch"),
  );
  assert.throws(
    () => createGitHubInstallationDiscoveryTransport({
      installationId,
      appJwt: { ...leases.appJwt, installationId: "12345679" },
      installationToken: leases.installationToken,
    }),
    discoveryError("lease_installation_mismatch"),
  );

  const expired = createLeases({
    appExpiresAt: Date.now() + 59_999,
  });
  const expiredTransport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: expired.appJwt,
    installationToken: expired.installationToken,
  });
  await assert.rejects(
    expiredTransport.readPage({ pageIndex: 0, cursor: null }),
    discoveryError("lease_expired"),
  );
  assert.deepEqual(expired.reveals, { app: 0, installation: 0 });
  assert.deepEqual(expired.releases, { app: 1, installation: 1 });

  const canary = `${appSecret}:${installationSecret}`;
  const hostile = createLeases({
    appReveal: () => {
      throw new Error(canary);
    },
  });
  const hostileTransport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: hostile.appJwt,
    installationToken: hostile.installationToken,
  });
  let captured: unknown;
  try {
    await hostileTransport.readPage({ pageIndex: 0, cursor: null });
  }
  catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof GitHubInstallationDiscoveryError);
  assert.equal(captured.code, "lease_unavailable");
  assert.doesNotMatch(JSON.stringify(captured), /canary|ghs_installation/u);
  assert.doesNotMatch(captured.stack ?? "", /ghs_installation_canary/u);
  assert.deepEqual(hostile.releases, { app: 1, installation: 1 });
});

test("hostile input reflection is typed without invoking accessors or leaking traps", async () => {
  const canary = `${appSecret}:${installationSecret}`;
  const hostileInput = new Proxy({}, {
    getPrototypeOf() {
      throw new Error(canary);
    },
  });
  assert.throws(
    () => createGitHubInstallationDiscoveryTransport(hostileInput as never),
    discoveryError("invalid_input"),
  );

  let getterRead = false;
  const accessorLease = {
    kind: "app-jwt",
    installationId,
    expiresAtEpochMs: Date.now() + 3_600_000,
    release: () => undefined,
  };
  Object.defineProperty(accessorLease, "reveal", {
    enumerable: true,
    get() {
      getterRead = true;
      return () => appSecret;
    },
  });
  const valid = createLeases();
  assert.throws(
    () => createGitHubInstallationDiscoveryTransport({
      installationId,
      appJwt: accessorLease as never,
      installationToken: valid.installationToken,
    }),
    discoveryError("invalid_input"),
  );
  assert.equal(getterRead, false);

  const pageLeases = createLeases();
  let requests = 0;
  const transport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: pageLeases.appJwt,
    installationToken: pageLeases.installationToken,
  }, {
    request: async () => {
      requests += 1;
      throw new Error("must not fetch");
    },
  });
  const hostilePage = new Proxy({}, {
    ownKeys() {
      throw new Error(canary);
    },
  });
  await assert.rejects(
    transport.readPage(hostilePage as never),
    discoveryError("sequence_violation"),
  );
  assert.equal(requests, 0);
  assert.deepEqual(pageLeases.releases, { app: 1, installation: 1 });
});

test("release failure is terminal, typed and never repeated", async () => {
  const leases = createLeases({ appRelease: () => {
    throw new Error(`${appSecret}:${installationSecret}`);
  } });
  await withProvider(
    { repositories: [repository(0)] },
    async (provider) => {
      const transport = createGitHubInstallationDiscoveryTransport({
        installationId,
        appJwt: leases.appJwt,
        installationToken: leases.installationToken,
      }, provider.runtime);
      await assert.rejects(
        transport.readPage({ pageIndex: 0, cursor: null }),
        discoveryError("lease_release_failed"),
      );
      assert.deepEqual(leases.releases, { app: 1, installation: 1 });
      await assert.rejects(
        transport.readPage({ pageIndex: 0, cursor: null }),
        discoveryError("sequence_violation"),
      );
      assert.deepEqual(leases.releases, { app: 1, installation: 1 });
    },
  );
});

test("HTTP status taxonomy is deterministic, body-free and never retries", async () => {
  for (const [options, code] of [
    [{ metadataStatus: 400 }, "api_version_unsupported"],
    [{ metadataStatus: 401 }, "authentication_rejected"],
    [{ metadataStatus: 403 }, "authentication_rejected"],
    [{ metadataStatus: 404 }, "installation_not_found"],
    [{ metadataStatus: 410 }, "api_version_unsupported"],
    [{ metadataStatus: 503 }, "upstream_failure"],
    [{
      metadataStatus: 429,
      responseHeaders: {
        "retry-after": "12",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1785220000",
      },
    }, "rate_limited"],
    [{
      metadataStatus: 403,
      responseHeaders: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1785220000",
      },
    }, "rate_limited"],
  ] as const) {
    await withProvider(options, async (provider) => {
      let captured: unknown;
      try {
        await provider.transport.readPage({ pageIndex: 0, cursor: null });
      }
      catch (error) {
        captured = error;
      }
      assert.ok(captured instanceof GitHubInstallationDiscoveryError);
      assert.equal(captured.code, code);
      assert.equal(provider.requests.length, 1);
      assert.doesNotMatch(JSON.stringify(captured), /provider-secret-body/u);
    });
  }
});

test("redirect, network and deadline failures expose no request or token", async () => {
  for (const [request, timeoutSignal, code] of [
    [
      async () => new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/steal" },
      }),
      undefined,
      "redirect_rejected",
    ],
    [
      async () => {
        throw new Error(`${appSecret}:${installationSecret}`);
      },
      undefined,
      "network_failure",
    ],
    [
      async (providerRequest: Request) => {
        await new Promise<void>((_resolve, reject) => {
          if (providerRequest.signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          providerRequest.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
        return new Response();
      },
      () => AbortSignal.abort(),
      "deadline_exceeded",
    ],
  ] as const) {
    const leases = createLeases();
    const transport = createGitHubInstallationDiscoveryTransport({
      installationId,
      appJwt: leases.appJwt,
      installationToken: leases.installationToken,
    }, {
      request,
      timeoutSignal,
    });
    let captured: unknown;
    try {
      await transport.readPage({ pageIndex: 0, cursor: null });
    }
    catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof GitHubInstallationDiscoveryError);
    assert.equal(captured.code, code);
    assert.doesNotMatch(JSON.stringify(captured), /canary|attacker/u);
    assert.deepEqual(leases.releases, { app: 1, installation: 1 });
  }
});

test("response bytes are bounded before JSON parsing", async () => {
  const oversizedDeclared = new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(
        GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES + 1,
      ),
    },
  });
  await assertResponseFailure(oversizedDeclared, "body_too_large");

  let cancelled = false;
  const overflow = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array(GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES),
      );
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await assertResponseFailure(overflow, "body_too_large");
  assert.equal(cancelled, true);

  await assertResponseFailure(
    new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    "malformed_response",
  );
  await assertResponseFailure(
    new Response("{}", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
    "malformed_response",
  );
  await assertResponseFailure(
    new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    "malformed_response",
  );
  await assertResponseFailure(
    new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    "malformed_response",
  );
  await assertResponseFailure(
    new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`${appSecret}:${installationSecret}`);
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    "response_stream_failure",
  );
});

test("the exact two-MiB response boundary remains usable", async () => {
  const metadataJson = JSON.stringify(metadata());
  const exactMetadata = metadataJson +
    " ".repeat(
      GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES -
      Buffer.byteLength(metadataJson),
    );
  const responses = [
    new Response(exactMetadata, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(
          GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES,
        ),
        etag: "\"installation-v1\"",
      },
    }),
    new Response(JSON.stringify({
      total_count: 1,
      repositories: [repository(0)],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(exactMetadata, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(
          GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES,
        ),
        etag: "\"installation-v1\"",
      },
    }),
  ];
  const leases = createLeases();
  const transport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: leases.appJwt,
    installationToken: leases.installationToken,
  }, {
    request: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
  });
  const source = await createGitHubInstallationSnapshotSource(transport);
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId,
      repositoryId: "10000",
    }))?.repository.name,
    "repo-0",
  );
  assert.deepEqual(leases.releases, { app: 1, installation: 1 });
});

test("the total deadline closes before starting another HTTP call", async () => {
  const leases = createLeases();
  let timeReads = 0;
  let requests = 0;
  const transport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: leases.appJwt,
    installationToken: leases.installationToken,
  }, {
    now: () => {
      timeReads += 1;
      return timeReads === 1 ? 1_000 : 46_001;
    },
    request: async () => {
      requests += 1;
      throw new Error("must not fetch");
    },
  });
  await assert.rejects(
    transport.readPage({ pageIndex: 0, cursor: null }),
    discoveryError("deadline_exceeded"),
  );
  assert.equal(requests, 0);
  assert.deepEqual(leases.releases, { app: 1, installation: 1 });
});

test("live acceptance skips honestly without credentials and emits no secret", () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GITHUB_")) delete environment[key];
  }
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/live/github-installation-discovery-live.mjs",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: environment,
    },
  );
  assert.equal(child.status, 2);
  assert.equal(child.stderr, "");
  const output = JSON.parse(child.stdout) as Record<string, unknown>;
  assert.equal(output.status, "SKIP");
  assert.equal(output.reason, "credentials_missing");
  assert.doesNotMatch(child.stdout, /Bearer|ghs_|jwt/u);
  const liveScript = readFileSync(
    "scripts/live/github-installation-discovery-live.mjs",
    "utf8",
  );
  assert.match(liveScript, /no_repository_in_installation/u);
  assert.doesNotMatch(liveScript, /repositoryIds\.length === 0\)\s*\{\s*throw/u);
});

function repository(index: number) {
  const name = `repo-${index}`;
  return {
    id: 10_000 + index,
    name,
    full_name: `Nexus-OS/${name}`,
    owner: { login: "Nexus-OS" },
    private: true,
  };
}

function metadata(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: Number(installationId),
    app_id: 4242,
    repository_selection: "selected",
    permissions: {
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      checks: "read",
      deployments: "write",
      contents: "write",
    },
    suspended_at: null,
    updated_at: providerUpdatedAt,
    ...overrides,
  };
}

function createLeases(
  options: Readonly<{
    appExpiresAt?: number;
    installationExpiresAt?: number;
    appReveal?: () => string;
    installationReveal?: () => string;
    appRelease?: () => void;
    installationRelease?: () => void;
  }> = {},
): Leases {
  const reveals = { app: 0, installation: 0 };
  const releases = { app: 0, installation: 0 };
  const expiry = Date.now() + 3_600_000;
  return {
    appJwt: {
      kind: "app-jwt",
      installationId,
      expiresAtEpochMs: options.appExpiresAt ?? expiry,
      reveal: () => {
        reveals.app += 1;
        return options.appReveal?.() ?? appSecret;
      },
      release: () => {
        releases.app += 1;
        options.appRelease?.();
      },
    },
    installationToken: {
      kind: "installation-token",
      installationId,
      expiresAtEpochMs: options.installationExpiresAt ?? expiry,
      reveal: () => {
        reveals.installation += 1;
        return options.installationReveal?.() ?? installationSecret;
      },
      release: () => {
        releases.installation += 1;
        options.installationRelease?.();
      },
    },
    reveals,
    releases,
  };
}

async function withProvider(
  options: ProviderOptions,
  run: (provider: Readonly<{
    transport: GitHubInstallationSnapshotTransport;
    runtime: GitHubInstallationDiscoveryRuntime;
    requests: RequestEvidence[];
    observations: GitHubInstallationDiscoveryHttpObservation[];
    leases: Leases;
    setFinalEtag(value: string): void;
  }>) => Promise<void>,
): Promise<void> {
  const repositories = options.repositories ?? [];
  let metadataCalls = 0;
  let finalEtag = "\"installation-v1\"";
  const server = createServer(
    (request, response) => {
      if (request.url === `/app/installations/${installationId}`) {
        metadataCalls += 1;
        sendJson(
          response,
          options.metadataStatus ?? 200,
          metadataCalls === 1
            ? options.metadata ?? metadata()
            : options.finalMetadata ?? options.metadata ?? metadata(),
          {
            etag: metadataCalls === 1
              ? "\"installation-v1\""
              : finalEtag,
            ...options.responseHeaders,
          },
        );
        return;
      }
      const url = new URL(request.url ?? "/", "http://loopback.invalid");
      if (url.pathname === "/installation/repositories") {
        const page = Number(url.searchParams.get("page"));
        const body = options.page?.(page, repositories) ?? {
          total_count: repositories.length,
          repositories: repositories.slice((page - 1) * 100, page * 100),
          repository_selection: "selected",
        };
        sendJson(
          response,
          options.repositoryStatus ?? 200,
          body,
          options.responseHeaders,
        );
        return;
      }
      sendJson(response, 404, { message: "provider-secret-body" });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const requests: RequestEvidence[] = [];
  const observations: GitHubInstallationDiscoveryHttpObservation[] = [];
  const leases = createLeases();
  const runtime: GitHubInstallationDiscoveryRuntime = {
    async request(providerRequest) {
      requests.push({
        authorization: providerRequest.headers.get("authorization"),
        method: providerRequest.method,
        redirect: providerRequest.redirect,
        url: providerRequest.url,
        userAgent: providerRequest.headers.get("user-agent"),
        accept: providerRequest.headers.get("accept"),
        apiVersion: providerRequest.headers.get("x-github-api-version"),
      });
      const providerUrl = new URL(providerRequest.url);
      return fetch(new Request(
        `${localOrigin}${providerUrl.pathname}${providerUrl.search}`,
        {
          method: providerRequest.method,
          headers: providerRequest.headers,
          redirect: providerRequest.redirect,
          signal: providerRequest.signal,
        },
      ));
    },
    observe(observation) {
      observations.push(observation);
    },
  };
  const transport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: leases.appJwt,
    installationToken: leases.installationToken,
  }, runtime);
  try {
    await run({
      transport,
      runtime,
      requests,
      observations,
      leases,
      setFinalEtag(value) {
        finalEtag = value;
      },
    });
  }
  finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function sendJson(
  response: ServerResponse<IncomingMessage>,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const body = status === 200
    ? JSON.stringify(value)
    : JSON.stringify({
      message: "provider-secret-body",
      secret: `${appSecret}:${installationSecret}`,
    });
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

async function assertResponseFailure(
  response: Response,
  code: GitHubInstallationDiscoveryErrorCode,
): Promise<void> {
  const leases = createLeases();
  const transport = createGitHubInstallationDiscoveryTransport({
    installationId,
    appJwt: leases.appJwt,
    installationToken: leases.installationToken,
  }, {
    request: async () => response,
  });
  await assert.rejects(
    transport.readPage({ pageIndex: 0, cursor: null }),
    discoveryError(code),
  );
  assert.deepEqual(leases.releases, { app: 1, installation: 1 });
}

function discoveryError(code: GitHubInstallationDiscoveryErrorCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof GitHubInstallationDiscoveryError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.doesNotMatch(
      JSON.stringify(error),
      /app\.jwt\.canary|ghs_installation_canary|provider-secret-body/u,
    );
    return true;
  };
}
