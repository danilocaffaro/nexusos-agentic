import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_AUTHORIZATION_SPEC_VERSION,
  GITHUB_INSTALLATION_STATES,
  GITHUB_REPOSITORY_PERMISSION_ACCESS,
  GITHUB_REPOSITORY_PERMISSION_NAMES,
  GITHUB_REPOSITORY_SELECTIONS,
} from "../../src/contracts/github-authorization";
import type {
  GitHubEffectIntentDescriptor,
} from "../../src/contracts/github-delivery";
import {
  authorizesEffect,
  parseGitHubInstallationScope,
} from "../../src/domain/github/github-authorization";

const repository = {
  installationId: "12345678",
  repositoryId: "987654321",
  owner: "nexus-os",
  name: "control_plane.git",
};

const fullScope = {
  specVersion: GITHUB_AUTHORIZATION_SPEC_VERSION,
  installationState: "active",
  repositorySelection: "selected",
  repository,
  permissions: [
    { name: "metadata", access: "read" },
    { name: "issues", access: "write" },
    { name: "pull_requests", access: "write" },
    { name: "checks", access: "read" },
    { name: "deployments", access: "write" },
    { name: "contents", access: "write" },
  ],
} as const;

test("GitHub installation authorization vocabularies are closed and Free compatible", () => {
  assert.equal(
    GITHUB_AUTHORIZATION_SPEC_VERSION,
    "nexusos.github-installation-scope.v1",
  );
  assert.deepEqual(GITHUB_INSTALLATION_STATES, ["active", "suspended"]);
  assert.deepEqual(GITHUB_REPOSITORY_SELECTIONS, ["all", "selected"]);
  assert.deepEqual(GITHUB_REPOSITORY_PERMISSION_NAMES, [
    "metadata",
    "issues",
    "pull_requests",
    "checks",
    "deployments",
    "contents",
  ]);
  assert.deepEqual(GITHUB_REPOSITORY_PERMISSION_ACCESS, ["read", "write"]);
});

test("installation scope parser canonicalizes repository identity and copies grants", () => {
  const input = {
    ...fullScope,
    repository: {
      ...repository,
      owner: "Nexus-OS",
      name: "Control_Plane.GIT",
    },
    permissions: fullScope.permissions.map((permission) => ({ ...permission })),
  };
  const parsed = parseGitHubInstallationScope(input);
  assert.deepEqual(parsed, fullScope);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed?.repository, input.repository);
  assert.notEqual(parsed?.permissions, input.permissions);
  for (let index = 0; index < input.permissions.length; index += 1) {
    assert.notEqual(parsed?.permissions[index], input.permissions[index]);
  }
  assert.deepEqual(
    parseGitHubInstallationScope({
      ...fullScope,
      repositorySelection: "all",
      permissions: [{ name: "metadata", access: "read" }],
    }),
    {
      ...fullScope,
      repositorySelection: "all",
      permissions: [{ name: "metadata", access: "read" }],
    },
  );
});

test("installation scope parser rejects noncanonical and excessive authority", () => {
  for (const invalid of [
    { ...fullScope, specVersion: "nexusos.github-installation-scope.v2" },
    { ...fullScope, installationState: "revoked" },
    { ...fullScope, repositorySelection: "none" },
    { ...fullScope, repository: { ...repository, repositoryId: "0" } },
    { ...fullScope, permissions: [] },
    { ...fullScope, permissions: [{ name: "issues", access: "write" }] },
    {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "write" },
        { name: "issues", access: "write" },
      ],
    },
    {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "read" },
        { name: "administration", access: "write" },
      ],
    },
    {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "read" },
        { name: "issues", access: "admin" },
      ],
    },
    {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "read" },
        { name: "issues", access: "read" },
        { name: "issues", access: "write" },
      ],
    },
    {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "read" },
        { name: "contents", access: "write" },
        { name: "deployments", access: "write" },
      ],
    },
    {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "read", expiresAt: null },
      ],
    },
    { ...fullScope, token: "must-not-exist" },
    Object.assign(Object.create({ inherited: true }), fullScope),
  ]) {
    assert.equal(parseGitHubInstallationScope(invalid), undefined);
  }
});

test("installation scope parser rejects symbols, accessors and exotic arrays", () => {
  const symbol = { ...fullScope, [Symbol("hidden")]: true };
  assert.equal(parseGitHubInstallationScope(symbol), undefined);

  const accessor = { ...fullScope };
  Object.defineProperty(accessor, "installationState", {
    enumerable: true,
    get: () => "active",
  });
  assert.equal(parseGitHubInstallationScope(accessor), undefined);

  const nonEnumerable = { ...fullScope };
  Object.defineProperty(nonEnumerable, "installationState", {
    enumerable: false,
    value: "active",
  });
  assert.equal(parseGitHubInstallationScope(nonEnumerable), undefined);

  const permissionAccessor = { name: "metadata", access: "read" };
  Object.defineProperty(permissionAccessor, "access", {
    enumerable: true,
    get: () => "read",
  });
  assert.equal(
    parseGitHubInstallationScope({
      ...fullScope,
      permissions: [permissionAccessor],
    }),
    undefined,
  );

  const permissionsWithSymbol = fullScope.permissions.map(
    (permission) => ({ ...permission }),
  );
  Object.defineProperty(permissionsWithSymbol, Symbol("hidden"), {
    enumerable: false,
    value: true,
  });
  assert.equal(
    parseGitHubInstallationScope({
      ...fullScope,
      permissions: permissionsWithSymbol,
    }),
    undefined,
  );

  const sparse = Array(2);
  sparse[0] = { name: "metadata", access: "read" };
  assert.equal(
    parseGitHubInstallationScope({ ...fullScope, permissions: sparse }),
    undefined,
  );

  class HostilePermissions extends Array<unknown> {
    override *[Symbol.iterator](): ArrayIterator<unknown> {
      yield { name: "metadata", access: "read" };
      yield { name: "contents", access: "write" };
    }
  }
  const hostilePermissions = new HostilePermissions();
  assert.equal(hostilePermissions.length, 0);
  assert.equal(JSON.stringify(hostilePermissions), "[]");
  assert.equal(
    parseGitHubInstallationScope({
      ...fullScope,
      permissions: hostilePermissions,
    }),
    undefined,
  );
  assert.equal(
    authorizesEffect(
      { ...fullScope, permissions: hostilePermissions } as never,
      {
        actionType: "github.pull_request.merge",
        repository,
        target: { kind: "pull_request", number: 17 },
      },
    ),
    false,
  );
});

test("installation scope parser fails closed for hostile proxies", () => {
  const hostile = new Proxy({}, {
    getPrototypeOf: () => {
      throw new Error("hostile");
    },
  });
  assert.equal(parseGitHubInstallationScope(hostile), undefined);
  assert.equal(
    parseGitHubInstallationScope({
      ...fullScope,
      permissions: [hostile],
    }),
    undefined,
  );
});

test("effect authorization enforces the exact least-privilege matrix", () => {
  const cases = [
    ["github.issue.create", { kind: "repository" }, "issues"],
    ["github.issue.update", { kind: "issue", number: 42 }, "issues"],
    ["github.pull_request.create", { kind: "repository" }, "pull_requests"],
    [
      "github.pull_request.request_review",
      { kind: "pull_request", number: 17 },
      "pull_requests",
    ],
    [
      "github.pull_request.merge",
      { kind: "pull_request", number: 17 },
      "contents",
    ],
    ["github.deployment.promote", { kind: "repository" }, "deployments"],
  ] as const;

  for (const [actionType, target, required] of cases) {
    const descriptor = { actionType, repository, target };
    assert.equal(authorizesEffect(fullScope, descriptor), true, actionType);
    const readOnly = {
      ...fullScope,
      permissions: fullScope.permissions.map((permission) =>
        permission.name === required
          ? { name: permission.name, access: "read" as const }
          : { ...permission }
      ),
    };
    assert.equal(
      authorizesEffect(readOnly as never, descriptor),
      false,
      `${actionType} must require ${required}:write`,
    );
    const unrelatedWrite = {
      ...fullScope,
      permissions: [
        { name: "metadata", access: "read" },
        required === "issues"
          ? { name: "pull_requests", access: "write" }
          : { name: "issues", access: "write" },
      ],
    };
    assert.equal(
      authorizesEffect(unrelatedWrite as never, descriptor),
      false,
      `${actionType} must reject unrelated write authority`,
    );
  }
});

test("effect authorization requires active state and exact repository installation", () => {
  const descriptor: GitHubEffectIntentDescriptor = {
    actionType: "github.issue.create",
    repository,
    target: { kind: "repository" },
  };
  assert.equal(
    authorizesEffect({ ...fullScope, installationState: "suspended" }, descriptor),
    false,
  );
  for (const changedRepository of [
    { ...repository, installationId: "12345679" },
    { ...repository, repositoryId: "987654322" },
    { ...repository, owner: "another-owner" },
    { ...repository, name: "another-repository" },
  ]) {
    assert.equal(
      authorizesEffect(
        fullScope,
        { ...descriptor, repository: changedRepository },
      ),
      false,
    );
  }
  assert.equal(
    authorizesEffect(
      {
        ...fullScope,
        repository: {
          ...repository,
          owner: "NEXUS-OS",
          name: "CONTROL_PLANE.GIT",
        },
      },
      descriptor,
    ),
    true,
  );
});

test("effect authorization reparses both inputs and fails closed", () => {
  const descriptor = {
    actionType: "github.pull_request.merge",
    repository,
    target: { kind: "pull_request", number: 17 },
  } as const;
  assert.equal(
    authorizesEffect(
      { ...fullScope, specVersion: "future" } as never,
      descriptor,
    ),
    false,
  );
  assert.equal(
    authorizesEffect(
      fullScope,
      { ...descriptor, target: { kind: "pull_request", number: 0 } } as never,
    ),
    false,
  );
  assert.equal(
    authorizesEffect(
      fullScope,
      { ...descriptor, actionType: "github.repository.delete" } as never,
    ),
    false,
  );
  const hostileDescriptor = new Proxy({}, {
    getPrototypeOf: () => {
      throw new Error("hostile");
    },
  });
  assert.equal(authorizesEffect(fullScope, hostileDescriptor as never), false);
});

test("checks permission never authorizes a delivery effect", () => {
  const checksOnly = {
    ...fullScope,
    permissions: [
      { name: "metadata", access: "read" },
      { name: "checks", access: "write" },
    ],
  } as const;
  const descriptors = [
    {
      actionType: "github.issue.create",
      repository,
      target: { kind: "repository" },
    },
    {
      actionType: "github.issue.update",
      repository,
      target: { kind: "issue", number: 42 },
    },
    {
      actionType: "github.pull_request.create",
      repository,
      target: { kind: "repository" },
    },
    {
      actionType: "github.pull_request.request_review",
      repository,
      target: { kind: "pull_request", number: 17 },
    },
    {
      actionType: "github.pull_request.merge",
      repository,
      target: { kind: "pull_request", number: 17 },
    },
    {
      actionType: "github.deployment.promote",
      repository,
      target: { kind: "repository" },
    },
  ] as const;
  for (const descriptor of descriptors) {
    assert.equal(authorizesEffect(checksOnly, descriptor), false);
  }
});

test("null-prototype installation scopes are accepted and copied", () => {
  const scope = Object.assign(Object.create(null), {
    ...fullScope,
    repository: Object.assign(Object.create(null), repository),
    permissions: fullScope.permissions.map((permission) =>
      Object.assign(Object.create(null), permission)
    ),
  });
  assert.deepEqual(parseGitHubInstallationScope(scope), fullScope);
});
