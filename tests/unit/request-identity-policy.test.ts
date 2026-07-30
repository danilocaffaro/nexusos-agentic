import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  IdentityConfigurationError,
  IdentityRequiredError,
  resolveRequestIdentity,
  type RequestIdentityEnvironment,
} from "../../src/adapters/identity/request-identity-policy";

const strongIntegrityKey = "k".repeat(32);
const privateAlphaEnvironment: RequestIdentityEnvironment = {
  NEXUS_MESSAGE_INTEGRITY_KEY: strongIntegrityKey,
  NEXUS_PRIVATE_ALPHA_IDENTITY: "1",
  NEXUS_PRIVATE_ALPHA_OWNER_EMAIL: "owner@example.com",
};
const identityAdapterSource = readFileSync(
  new URL(
    "../../src/adapters/identity/request-identity.ts",
    import.meta.url,
  ),
  "utf8",
);
const workspaceBootstrapSource = readFileSync(
  new URL(
    "../../src/adapters/d1/local-workspace.ts",
    import.meta.url,
  ),
  "utf8",
);

test("private alpha maps the one allowlisted Sites identity to fixed ownership", () => {
  const identity = resolveRequestIdentity(
    request("https://nexus.example/api/workspace", {
      "oai-authenticated-user-email": "Owner@Example.com",
    }),
    privateAlphaEnvironment,
  );

  assert.deepEqual(identity, {
    id: "principal-local-owner",
    kind: "human",
    displayName: "owner@example.com",
    organizationId: "org-local-aurora",
  });
});

test("private alpha rejects absent, different and ambiguous forwarded identities", () => {
  for (const email of [
    undefined,
    "other@example.com",
    "owner@example.com,other@example.com",
    "owner @example.com",
    "owner@@example.com",
  ]) {
    assert.throws(
      () =>
        resolveRequestIdentity(
          request(
            "https://nexus.example/api/workspace",
            email
              ? { "oai-authenticated-user-email": email }
              : undefined,
          ),
          privateAlphaEnvironment,
        ),
      IdentityRequiredError,
    );
  }
});

test("forwarded Sites identity is inert unless private alpha is explicit", () => {
  assert.throws(
    () =>
      resolveRequestIdentity(
        request("https://nexus.example/api/workspace", {
          "oai-authenticated-user-email": "owner@example.com",
        }),
        {},
      ),
    IdentityRequiredError,
  );
});

test("private alpha fails closed when its allowlist or integrity key is unsafe", () => {
  for (const override of [
    { NEXUS_PRIVATE_ALPHA_OWNER_EMAIL: undefined },
    { NEXUS_PRIVATE_ALPHA_OWNER_EMAIL: "owner@example.com,attacker@example.com" },
    { NEXUS_MESSAGE_INTEGRITY_KEY: undefined },
    { NEXUS_MESSAGE_INTEGRITY_KEY: "short" },
  ]) {
    assert.throws(
      () =>
        resolveRequestIdentity(
          request("https://nexus.example/api/workspace", {
            "oai-authenticated-user-email": "owner@example.com",
          }),
          { ...privateAlphaEnvironment, ...override },
        ),
      IdentityConfigurationError,
    );
  }
});

test("private alpha rejects localhost and conflicting impersonation flags", () => {
  for (const override of [
    { requestUrl: "http://127.0.0.1:3002/api/workspace" },
    { NEXUS_ALLOW_LOCAL_IDENTITY: "1" },
    { NEXUS_ALLOW_TEST_IDENTITIES: "1" },
  ]) {
    assert.throws(
      () =>
        resolveRequestIdentity(
          request(
            override.requestUrl ??
              "https://nexus.example/api/workspace",
            { "oai-authenticated-user-email": "owner@example.com" },
          ),
          { ...privateAlphaEnvironment, ...override },
        ),
      IdentityConfigurationError,
    );
  }
});

test("local and test identities preserve localhost-only guards", () => {
  assert.deepEqual(
    resolveRequestIdentity(
      request("http://localhost:3002/api/workspace"),
      { NEXUS_ALLOW_LOCAL_IDENTITY: "1" },
    ),
    {
      id: "principal-local-owner",
      kind: "human",
      displayName: "Local owner",
      organizationId: "org-local-aurora",
    },
  );

  const testHeaders = {
    "x-nexus-test-principal": "principal-test",
    "x-nexus-test-organization": "org-test",
    "x-nexus-test-display-name": "Test owner",
  };
  assert.deepEqual(
    resolveRequestIdentity(
      request("http://[::1]:3002/api/workspace", testHeaders),
      { NEXUS_ALLOW_TEST_IDENTITIES: "1" },
    ),
    {
      id: "principal-test",
      kind: "human",
      displayName: "Test owner",
      organizationId: "org-test",
    },
  );
  assert.throws(
    () =>
      resolveRequestIdentity(
        request("https://nexus.example/api/workspace", testHeaders),
        { NEXUS_ALLOW_TEST_IDENTITIES: "1" },
      ),
    IdentityRequiredError,
  );
});

test("runtime and workspace bootstrap consume the closed policy boundary", () => {
  assert.match(
    identityAdapterSource,
    /return resolveRequestIdentity\(request, env\);/u,
  );
  assert.doesNotMatch(
    identityAdapterSource,
    /oai-authenticated-user-email/u,
  );
  assert.match(
    workspaceBootstrapSource,
    /NEXUS_PRIVATE_ALPHA_IDENTITY === "1"/u,
  );
  assert.match(
    workspaceBootstrapSource,
    /requireBootstrapIntegrityKey\(privateAlpha\)/u,
  );
  assert.match(
    workspaceBootstrapSource,
    /hasStrongMessageIntegrityKey\(configured\)/u,
  );
});

function request(
  url: string,
  headers?: Record<string, string>,
): Request {
  return new Request(url, { headers });
}
