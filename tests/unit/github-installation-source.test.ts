import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES,
  GITHUB_INSTALLATION_SOURCE_SPEC_VERSION,
} from "../../src/contracts/github-installation-source";
import type {
  GitHubInstallationSourceFixture,
} from "../../src/contracts/github-installation-source";
import {
  GITHUB_AUTHORIZATION_SPEC_VERSION,
} from "../../src/contracts/github-authorization";
import {
  createGitHubInstallationFixtureSource,
} from "../../src/domain/github/github-installation-source";

const fixture = {
  specVersion: GITHUB_INSTALLATION_SOURCE_SPEC_VERSION,
  installationId: "12345678",
  installationState: "active",
  repositorySelection: "selected",
  permissions: {
    contents: "write",
    metadata: "read",
    issues: "write",
    checks: "read",
  },
  repositories: [
    {
      repositoryId: "987654321",
      owner: "Nexus-OS",
      name: "Control_Plane.GIT",
    },
    {
      repositoryId: "987654322",
      owner: "nexus-os",
      name: "runtime",
    },
  ],
} as const satisfies GitHubInstallationSourceFixture;

test("installation source fixture vocabulary is versioned and bounded", () => {
  assert.equal(
    GITHUB_INSTALLATION_SOURCE_SPEC_VERSION,
    "nexusos.github-installation-source-fixture.v1",
  );
  assert.equal(GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES, 500);
});

test("fixture source normalizes permissions and proves selected membership", async () => {
  const source = createGitHubInstallationFixtureSource(fixture);
  assert.ok(source);
  assert.equal(Object.isFrozen(source), true);
  assert.deepEqual(Reflect.ownKeys(source), ["readScope"]);
  assert.deepEqual(
    await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "987654321",
    }),
    {
      specVersion: GITHUB_AUTHORIZATION_SPEC_VERSION,
      installationState: "active",
      repositorySelection: "selected",
      repository: {
        installationId: "12345678",
        repositoryId: "987654321",
        owner: "nexus-os",
        name: "control_plane.git",
      },
      permissions: [
        { name: "metadata", access: "read" },
        { name: "issues", access: "write" },
        { name: "checks", access: "read" },
        { name: "contents", access: "write" },
      ],
    },
  );
});

test("all selection remains fail-closed to the exact fixture snapshot", async () => {
  const source = createGitHubInstallationFixtureSource({
    ...fixture,
    repositorySelection: "all",
    repositories: [fixture.repositories[0]],
  });
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "987654321",
    }))?.repositorySelection,
    "all",
  );
  assert.equal(
    await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "987654322",
    }),
    undefined,
  );
  assert.equal(
    await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "11111111",
    }),
    undefined,
  );
});

test("fixture source preserves suspension without converting it to authority", async () => {
  const source = createGitHubInstallationFixtureSource({
    ...fixture,
    installationState: "suspended",
  });
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "987654321",
    }))?.installationState,
    "suspended",
  );
});

test("lookup rejects absent repositories, crossed installations and malformed IDs", async () => {
  const source = createGitHubInstallationFixtureSource(fixture);
  assert.ok(source);
  for (const lookup of [
    { installationId: "12345679", repositoryId: "987654321" },
    { installationId: "12345678", repositoryId: "987654323" },
    { installationId: "012345678", repositoryId: "987654321" },
    { installationId: "12345678", repositoryId: "9223372036854775808" },
    { installationId: "12345678", repositoryId: 987654321 },
    {
      installationId: "12345678",
      repositoryId: "987654321",
      owner: "nexus-os",
    },
  ]) {
    assert.equal(await source.readScope(lookup as never), undefined);
  }

  let getterRead = false;
  const accessorLookup = { installationId: fixture.installationId };
  Object.defineProperty(accessorLookup, "repositoryId", {
    enumerable: true,
    get: () => {
      getterRead = true;
      return "987654321";
    },
  });
  assert.equal(await source.readScope(accessorLookup as never), undefined);
  assert.equal(getterRead, false);
});

test("source owns a snapshot and each read returns an independent scope", async () => {
  const mutableFixture = {
    ...fixture,
    permissions: { ...fixture.permissions },
    repositories: fixture.repositories.map((repository) => ({ ...repository })),
  };
  const source = createGitHubInstallationFixtureSource(mutableFixture);
  assert.ok(source);
  const hostileMutation = mutableFixture as unknown as {
    installationId: string;
    permissions: { contents: string };
    repositories: Array<{ owner: string }>;
  };
  hostileMutation.installationId = "12345679";
  hostileMutation.permissions.contents = "read";
  hostileMutation.repositories[0]!.owner = "attacker";

  const lookup = {
    installationId: fixture.installationId,
    repositoryId: "987654321",
  };
  const first = await source.readScope(lookup);
  assert.ok(first);
  (first.repository as { owner: string }).owner = "mutated";
  (first.permissions as { name: string; access: string }[])[3]!.access = "read";

  const second = await source.readScope(lookup);
  assert.equal(second?.repository.owner, "nexus-os");
  assert.deepEqual(second?.permissions[3], {
    name: "contents",
    access: "write",
  });
  assert.notEqual(first, second);
  assert.notEqual(first.repository, second?.repository);
  assert.notEqual(first.permissions, second?.permissions);

  const independent = createGitHubInstallationFixtureSource(mutableFixture);
  assert.ok(independent);
  assert.equal(
    await independent.readScope(lookup),
    undefined,
    "a later source sees the fixture's later installation identity",
  );
});

test("fixture parser rejects duplicates and unknown or excessive permissions", () => {
  for (const invalid of [
    {
      ...fixture,
      repositories: [
        fixture.repositories[0],
        { ...fixture.repositories[1], repositoryId: "987654321" },
      ],
    },
    {
      ...fixture,
      repositories: [
        fixture.repositories[0],
        { ...fixture.repositories[1], name: "Control_Plane.GIT" },
      ],
    },
    {
      ...fixture,
      permissions: { ...fixture.permissions, administration: "write" },
    },
    {
      ...fixture,
      permissions: { ...fixture.permissions, metadata: "write" },
    },
    {
      ...fixture,
      permissions: { ...fixture.permissions, issues: "admin" },
    },
    {
      ...fixture,
      permissions: { issues: "write" },
    },
    {
      ...fixture,
      permissions: {},
    },
  ]) {
    assert.equal(createGitHubInstallationFixtureSource(invalid), undefined);
  }
});

test("fixture parser rejects malformed repositories and source envelopes", () => {
  for (const invalid of [
    { ...fixture, specVersion: "future" },
    { ...fixture, installationId: "0" },
    { ...fixture, installationState: "revoked" },
    { ...fixture, repositorySelection: "none" },
    { ...fixture, extra: true },
    {
      ...fixture,
      repositories: [{ ...fixture.repositories[0], repositoryId: "0" }],
    },
    {
      ...fixture,
      repositories: [{ ...fixture.repositories[0], owner: "-nexus-os" }],
    },
    {
      ...fixture,
      repositories: [{ ...fixture.repositories[0], archived: false }],
    },
    {
      ...fixture,
      repositories: {},
    },
    {
      ...fixture,
      repositories: [null],
    },
    Object.assign(Object.create({ inherited: true }), fixture),
  ]) {
    assert.equal(createGitHubInstallationFixtureSource(invalid), undefined);
  }
});

test("fixture parser rejects accessors, symbols, sparse and exotic arrays", () => {
  const accessor = { ...fixture };
  Object.defineProperty(accessor, "installationState", {
    enumerable: true,
    get: () => "active",
  });
  assert.equal(createGitHubInstallationFixtureSource(accessor), undefined);

  const symbol = { ...fixture, [Symbol("hidden")]: true };
  assert.equal(createGitHubInstallationFixtureSource(symbol), undefined);

  const permissionAccessor = { ...fixture.permissions };
  Object.defineProperty(permissionAccessor, "issues", {
    enumerable: true,
    get: () => "write",
  });
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      permissions: permissionAccessor,
    }),
    undefined,
  );

  const sparse = Array(2);
  sparse[0] = fixture.repositories[0];
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      repositories: sparse,
    }),
    undefined,
  );

  class ExoticRepositories extends Array<unknown> {}
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      repositories: new ExoticRepositories(),
    }),
    undefined,
  );
});

test("fixture parser enforces the inclusive 0..500 repository bound", async () => {
  const empty = createGitHubInstallationFixtureSource({
    ...fixture,
    repositories: [],
  });
  assert.ok(empty);
  assert.equal(
    await empty.readScope({
      installationId: fixture.installationId,
      repositoryId: "987654321",
    }),
    undefined,
  );

  const repositories = Array.from(
    { length: GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES },
    (_, index) => ({
      repositoryId: String(index + 1),
      owner: "nexus-os",
      name: `repo-${index + 1}`,
    }),
  );
  assert.ok(createGitHubInstallationFixtureSource({
    ...fixture,
    repositories,
  }));
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      repositories: [
        ...repositories,
        { repositoryId: "501", owner: "nexus-os", name: "repo-501" },
      ],
    }),
    undefined,
  );

  assert.ok(createGitHubInstallationFixtureSource({
    ...fixture,
    installationId: "9223372036854775807",
    repositories: [],
  }));
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      installationId: "9223372036854775808",
      repositories: [],
    }),
    undefined,
  );
});

test("fixture parsing uses one permission-key and repository-length snapshot", async () => {
  const permissionTarget = { metadata: "read" };
  const permissionProxy = new Proxy(permissionTarget, {
    ownKeys: () => ["metadata"],
    getOwnPropertyDescriptor: (target, key) =>
      key === "contents"
        ? {
          configurable: true,
          enumerable: true,
          value: "write",
          writable: true,
        }
        : Reflect.getOwnPropertyDescriptor(target, key),
  });
  const permissionSource = createGitHubInstallationFixtureSource({
    ...fixture,
    permissions: permissionProxy,
  });
  assert.ok(permissionSource);
  assert.deepEqual(
    (await permissionSource.readScope({
      installationId: fixture.installationId,
      repositoryId: fixture.repositories[0].repositoryId,
    }))?.permissions,
    [{ name: "metadata", access: "read" }],
  );

  const repositories = Array.from({ length: 501 }, (_, index) => ({
    repositoryId: String(index + 1),
    owner: "nexus-os",
    name: `repo-${index + 1}`,
  }));
  let lengthReads = 0;
  const repositoryProxy = new Proxy(repositories, {
    get: (target, key, receiver) => {
      if (key === "length") {
        lengthReads += 1;
        return lengthReads === 1 ? 0 : target.length;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      repositories: repositoryProxy,
    }),
    undefined,
  );
  assert.equal(lengthReads, 1);
});

test("the same repository name under distinct owners is unambiguous", async () => {
  const source = createGitHubInstallationFixtureSource({
    ...fixture,
    repositories: [
      { repositoryId: "1", owner: "owner-a", name: "shared" },
      { repositoryId: "2", owner: "owner-b", name: "shared" },
    ],
  });
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "1",
    }))?.repository.owner,
    "owner-a",
  );
  assert.equal(
    (await source.readScope({
      installationId: fixture.installationId,
      repositoryId: "2",
    }))?.repository.owner,
    "owner-b",
  );
});

test("fixture source fails closed for hostile reflection in creation and lookup", async () => {
  const hostile = new Proxy({}, {
    getPrototypeOf: () => {
      throw new Error("hostile");
    },
  });
  assert.equal(createGitHubInstallationFixtureSource(hostile), undefined);
  assert.equal(
    createGitHubInstallationFixtureSource({
      ...fixture,
      repositories: [hostile],
    }),
    undefined,
  );
  const source = createGitHubInstallationFixtureSource(fixture);
  assert.ok(source);
  assert.equal(await source.readScope(hostile as never), undefined);
});
