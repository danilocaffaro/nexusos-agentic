import type {
  GitHubInstallationScopeLookup,
  GitHubInstallationScopeSource,
} from "../../contracts/github-installation-source";
import {
  GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES,
  GITHUB_INSTALLATION_SOURCE_SPEC_VERSION,
} from "../../contracts/github-installation-source";
import type {
  GitHubInstallationScope,
  GitHubRepositoryPermissionGrant,
} from "../../contracts/github-authorization";
import {
  GITHUB_AUTHORIZATION_SPEC_VERSION,
  GITHUB_INSTALLATION_STATES,
  GITHUB_REPOSITORY_PERMISSION_ACCESS,
  GITHUB_REPOSITORY_PERMISSION_NAMES,
  GITHUB_REPOSITORY_SELECTIONS,
} from "../../contracts/github-authorization";
import {
  parseGitHubInstallationScope,
} from "./github-authorization";
import {
  parseGitHubRepositoryInstallation,
} from "./github-delivery";

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const MAX_GITHUB_ID = "9223372036854775807";

export function createGitHubInstallationFixtureSource(
  input: unknown,
): GitHubInstallationScopeSource | undefined {
  try {
    const fixture = parseFixture(input);
    if (!fixture) return undefined;
    const installationId = fixture.installationId;

    const scopesByRepositoryId = new Map<string, GitHubInstallationScope>();
    const repositoryLabels = new Set<string>();
    for (const candidate of fixture.repositories) {
      const repositoryValue = exactRecord(candidate, [
        "name",
        "owner",
        "repositoryId",
      ]);
      if (!repositoryValue) return undefined;
      const name = ownData(repositoryValue, "name");
      const owner = ownData(repositoryValue, "owner");
      const repositoryId = ownData(repositoryValue, "repositoryId");
      const repository = parseGitHubRepositoryInstallation({
        installationId,
        repositoryId,
        owner,
        name,
      });
      if (!repository || scopesByRepositoryId.has(repository.repositoryId)) {
        return undefined;
      }
      const label = `${repository.owner}/${repository.name}`;
      if (repositoryLabels.has(label)) return undefined;

      const scope = parseGitHubInstallationScope({
        specVersion: GITHUB_AUTHORIZATION_SPEC_VERSION,
        installationState: fixture.installationState,
        repositorySelection: fixture.repositorySelection,
        repository,
        permissions: fixture.permissions,
      });
      if (!scope) return undefined;
      scopesByRepositoryId.set(repository.repositoryId, scope);
      repositoryLabels.add(label);
    }

    return Object.freeze({
      async readScope(
        lookup: GitHubInstallationScopeLookup,
      ): Promise<GitHubInstallationScope | undefined> {
        try {
          const parsedLookup = parseLookup(lookup);
          if (
            !parsedLookup ||
            parsedLookup.installationId !== installationId
          ) {
            return undefined;
          }
          const scope = scopesByRepositoryId.get(parsedLookup.repositoryId);
          const parsedScope = scope
            ? parseGitHubInstallationScope(scope)
            : undefined;
          return parsedScope &&
              parsedScope.repository.installationId ===
                parsedLookup.installationId &&
              parsedScope.repository.repositoryId === parsedLookup.repositoryId
            ? parsedScope
            : undefined;
        }
        catch {
          return undefined;
        }
      },
    });
  }
  catch {
    return undefined;
  }
}

type ParsedFixture = Readonly<{
  installationId: string;
  installationState: GitHubInstallationScope["installationState"];
  repositorySelection: GitHubInstallationScope["repositorySelection"];
  permissions: readonly GitHubRepositoryPermissionGrant[];
  repositories: readonly unknown[];
}>;

function parseFixture(input: unknown): ParsedFixture | undefined {
  const value = exactRecord(input, [
    "installationId",
    "installationState",
    "permissions",
    "repositories",
    "repositorySelection",
    "specVersion",
  ]);
  if (!value) return undefined;

  const installationId = ownData(value, "installationId");
  const installationState = ownData(value, "installationState");
  const permissionInput = ownData(value, "permissions");
  const repositoryInput = ownData(value, "repositories");
  const repositorySelection = ownData(value, "repositorySelection");
  const specVersion = ownData(value, "specVersion");
  if (
    specVersion !== GITHUB_INSTALLATION_SOURCE_SPEC_VERSION ||
    !decimalId(installationId) ||
    !member(GITHUB_INSTALLATION_STATES, installationState) ||
    !member(GITHUB_REPOSITORY_SELECTIONS, repositorySelection)
  ) {
    return undefined;
  }
  const permissions = parsePermissions(permissionInput);
  const repositories = exactArray(
    repositoryInput,
    GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES,
  );
  return permissions && repositories
    ? {
      installationId,
      installationState,
      repositorySelection,
      permissions,
      repositories,
    }
    : undefined;
}

function parsePermissions(
  input: unknown,
): readonly GitHubRepositoryPermissionGrant[] | undefined {
  const value = record(input);
  if (!value) return undefined;
  const actual = Reflect.ownKeys(value);
  if (
    actual.length === 0 ||
    actual.length > GITHUB_REPOSITORY_PERMISSION_NAMES.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !GITHUB_REPOSITORY_PERMISSION_NAMES.includes(
          key as GitHubRepositoryPermissionGrant["name"],
        ),
    )
  ) {
    return undefined;
  }

  const permissions: GitHubRepositoryPermissionGrant[] = [];
  const declared = new Set(actual as string[]);
  for (const name of GITHUB_REPOSITORY_PERMISSION_NAMES) {
    if (!declared.has(name)) continue;
    const access = ownData(value, name);
    if (
      !member(GITHUB_REPOSITORY_PERMISSION_ACCESS, access) ||
      (name === "metadata" && access !== "read")
    ) {
      return undefined;
    }
    permissions.push({ name, access } as GitHubRepositoryPermissionGrant);
  }
  return permissions[0]?.name === "metadata" &&
      permissions[0].access === "read"
    ? permissions
    : undefined;
}

function parseLookup(
  input: unknown,
): GitHubInstallationScopeLookup | undefined {
  const value = exactRecord(input, ["installationId", "repositoryId"]);
  if (!value) return undefined;
  const installationId = ownData(value, "installationId");
  const repositoryId = ownData(value, "repositoryId");
  return decimalId(installationId) && decimalId(repositoryId)
    ? { installationId, repositoryId }
    : undefined;
}

function exactRecord(
  input: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  const value = record(input);
  if (!value) return undefined;
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length &&
      actual.every((key) => typeof key === "string" && expected.includes(key)) &&
      expected.every((key) => ownData(value, key) !== undefined)
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function exactArray(input: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    return undefined;
  }
  const length = input.length;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum
  ) {
    return undefined;
  }
  const actual = Reflect.ownKeys(input);
  if (actual.length !== length + 1 || actual.at(-1) !== "length") {
    return undefined;
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== String(index)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    values.push(descriptor.value);
  }
  return values;
}

function decimalId(value: unknown): value is string {
  return typeof value === "string" &&
    DECIMAL_ID.test(value) &&
    (value.length < MAX_GITHUB_ID.length ||
      (value.length === MAX_GITHUB_ID.length && value <= MAX_GITHUB_ID));
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
