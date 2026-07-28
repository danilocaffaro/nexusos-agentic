import type {
  GitHubInstallationScope,
  GitHubRepositoryPermissionGrant,
  GitHubRepositoryPermissionName,
} from "../../contracts/github-authorization";
import {
  GITHUB_AUTHORIZATION_SPEC_VERSION,
  GITHUB_INSTALLATION_STATES,
  GITHUB_REPOSITORY_PERMISSION_ACCESS,
  GITHUB_REPOSITORY_PERMISSION_NAMES,
  GITHUB_REPOSITORY_SELECTIONS,
} from "../../contracts/github-authorization";
import type {
  GitHubEffectIntentDescriptor,
  GitHubRepositoryInstallation,
} from "../../contracts/github-delivery";
import {
  parseGitHubEffectIntentDescriptor,
  parseGitHubRepositoryInstallation,
} from "./github-delivery";

const REQUIRED_WRITE_PERMISSION: Readonly<
  Record<
    GitHubEffectIntentDescriptor["actionType"],
    GitHubRepositoryPermissionName
  >
> = {
  "github.issue.create": "issues",
  "github.issue.update": "issues",
  "github.pull_request.create": "pull_requests",
  "github.pull_request.request_review": "pull_requests",
  "github.pull_request.merge": "contents",
  "github.deployment.promote": "deployments",
};

export function parseGitHubInstallationScope(
  input: unknown,
): GitHubInstallationScope | undefined {
  try {
    const value = record(input);
    if (
      !value ||
      !keys(value, [
        "installationState",
        "permissions",
        "repository",
        "repositorySelection",
        "specVersion",
      ]) ||
      value.specVersion !== GITHUB_AUTHORIZATION_SPEC_VERSION ||
      !member(GITHUB_INSTALLATION_STATES, value.installationState) ||
      !member(GITHUB_REPOSITORY_SELECTIONS, value.repositorySelection) ||
      !canonicalArray(value.permissions)
    ) {
      return undefined;
    }

    const repository = parseGitHubRepositoryInstallation(value.repository);
    if (!repository) return undefined;

    const permissions: GitHubRepositoryPermissionGrant[] = [];
    let previousIndex = -1;
    for (let index = 0; index < value.permissions.length; index += 1) {
      const permission = parsePermissionGrant(value.permissions[index]);
      if (!permission) return undefined;
      const permissionIndex =
        GITHUB_REPOSITORY_PERMISSION_NAMES.indexOf(permission.name);
      if (permissionIndex <= previousIndex) return undefined;
      previousIndex = permissionIndex;
      permissions.push(permission);
    }
    if (
      permissions.length === 0 ||
      permissions[0]?.name !== "metadata" ||
      permissions[0].access !== "read"
    ) {
      return undefined;
    }

    return {
      specVersion: GITHUB_AUTHORIZATION_SPEC_VERSION,
      installationState: value.installationState,
      repositorySelection: value.repositorySelection,
      repository,
      permissions,
    };
  }
  catch {
    return undefined;
  }
}

export function authorizesEffect(
  scope: GitHubInstallationScope,
  descriptor: GitHubEffectIntentDescriptor,
): boolean {
  try {
    const parsedScope = parseGitHubInstallationScope(scope);
    const parsedDescriptor = parseGitHubEffectIntentDescriptor(descriptor);
    if (
      !parsedScope ||
      !parsedDescriptor ||
      parsedScope.installationState !== "active" ||
      !sameRepository(parsedScope.repository, parsedDescriptor.repository)
    ) {
      return false;
    }

    const required = REQUIRED_WRITE_PERMISSION[parsedDescriptor.actionType];
    return parsedScope.permissions.some(
      (permission) =>
        permission.name === required && permission.access === "write",
    );
  }
  catch {
    return false;
  }
}

function parsePermissionGrant(
  input: unknown,
): GitHubRepositoryPermissionGrant | undefined {
  const value = record(input);
  if (
    !value ||
    !keys(value, ["access", "name"]) ||
    !member(GITHUB_REPOSITORY_PERMISSION_NAMES, value.name) ||
    !member(GITHUB_REPOSITORY_PERMISSION_ACCESS, value.access) ||
    (value.name === "metadata" && value.access !== "read")
  ) {
    return undefined;
  }
  return { name: value.name, access: value.access } as
    GitHubRepositoryPermissionGrant;
}

function sameRepository(
  left: GitHubRepositoryInstallation,
  right: GitHubRepositoryInstallation,
): boolean {
  return left.installationId === right.installationId &&
    left.repositoryId === right.repositoryId &&
    left.owner === right.owner &&
    left.name === right.name;
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

function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length &&
    actual.every((key) => {
      if (typeof key !== "string" || !expected.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    });
}

function canonicalArray(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > GITHUB_REPOSITORY_PERMISSION_NAMES.length
  ) {
    return false;
  }
  const actual = Reflect.ownKeys(value);
  if (actual.length !== value.length + 1 || actual.at(-1) !== "length") {
    return false;
  }
  return actual.slice(0, -1).every((key, index) => {
    if (key !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
