import type {
  GitHubInstallationSnapshotTransport,
} from "../../contracts/github-installation-snapshot";
import {
  GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH,
  GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS,
  GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION,
} from "../../contracts/github-installation-snapshot";
import type {
  GitHubInstallationPermissionFixture,
  GitHubInstallationRepositoryFixture,
  GitHubInstallationScopeSource,
  GitHubInstallationSourceFixture,
} from "../../contracts/github-installation-source";
import {
  GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES,
  GITHUB_INSTALLATION_SOURCE_SPEC_VERSION,
} from "../../contracts/github-installation-source";
import {
  GITHUB_INSTALLATION_STATES,
  GITHUB_REPOSITORY_PERMISSION_ACCESS,
  GITHUB_REPOSITORY_PERMISSION_NAMES,
  GITHUB_REPOSITORY_SELECTIONS,
} from "../../contracts/github-authorization";
import {
  createGitHubInstallationFixtureSource,
} from "./github-installation-source";

export async function createGitHubInstallationSnapshotSource(
  input: GitHubInstallationSnapshotTransport,
): Promise<GitHubInstallationScopeSource | undefined> {
  try {
    const readPage = captureReadPage(input);
    if (!readPage) return undefined;

    let cursor: string | null = null;
    let installation: ParsedInstallation | undefined;
    let totalRepositories: number | undefined;
    const seenCursors = new Set<string>();
    const repositories: GitHubInstallationRepositoryFixture[] = [];

    for (
      let pageIndex = 0;
      pageIndex < GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS;
      pageIndex += 1
    ) {
      const pageInput = Object.freeze({ pageIndex, cursor });
      const page = parsePage(await readPage(pageInput));
      if (
        !page ||
        page.pageIndex !== pageIndex ||
        page.cursor !== cursor
      ) {
        return undefined;
      }

      if (!installation) {
        installation = page.installation;
        totalRepositories = page.totalRepositories;
      }
      else if (
        totalRepositories !== page.totalRepositories ||
        !sameInstallation(installation, page.installation)
      ) {
        return undefined;
      }

      if (
        repositories.length + page.repositories.length >
          page.totalRepositories
      ) {
        return undefined;
      }
      repositories.push(...page.repositories);

      if (page.nextCursor === null) {
        if (
          repositories.length !== totalRepositories
        ) {
          return undefined;
        }
        const fixture: GitHubInstallationSourceFixture = {
          specVersion: GITHUB_INSTALLATION_SOURCE_SPEC_VERSION,
          installationId: installation.installationId,
          installationState: installation.installationState,
          repositorySelection: installation.repositorySelection,
          permissions: installation.permissions,
          repositories,
        };
        return createGitHubInstallationFixtureSource(fixture);
      }

      if (
        repositories.length >= page.totalRepositories ||
        seenCursors.has(page.nextCursor)
      ) {
        return undefined;
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return undefined;
  }
  catch {
    return undefined;
  }
}

type ReadPage = GitHubInstallationSnapshotTransport["readPage"];

type ParsedInstallation = Readonly<{
  installationId: string;
  installationState: GitHubInstallationSourceFixture["installationState"];
  repositorySelection: GitHubInstallationSourceFixture["repositorySelection"];
  permissions: GitHubInstallationPermissionFixture;
}>;

type ParsedPage = Readonly<{
  pageIndex: number;
  cursor: string | null;
  nextCursor: string | null;
  totalRepositories: number;
  installation: ParsedInstallation;
  repositories: readonly GitHubInstallationRepositoryFixture[];
}>;

function captureReadPage(input: unknown): ReadPage | undefined {
  const transport = exactRecord(input, ["readPage"]);
  const readPage = transport?.readPage;
  return typeof readPage === "function"
    ? readPage as ReadPage
    : undefined;
}

function parsePage(input: unknown): ParsedPage | undefined {
  const page = exactRecord(input, [
    "cursor",
    "installation",
    "nextCursor",
    "pageIndex",
    "repositories",
    "specVersion",
    "totalRepositories",
  ]);
  if (!page) return undefined;
  const pageIndex = page.pageIndex;
  const cursor = parseCursor(page.cursor);
  const nextCursor = parseCursor(page.nextCursor);
  const totalRepositories = page.totalRepositories;
  const installation = parseInstallation(page.installation);
  const repositoryInputs = exactArray(
    page.repositories,
    GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES,
  );
  if (
    page.specVersion !== GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION ||
    !Number.isSafeInteger(pageIndex) ||
    (pageIndex as number) < 0 ||
    (pageIndex as number) >= GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS ||
    cursor === undefined ||
    nextCursor === undefined ||
    !Number.isSafeInteger(totalRepositories) ||
    (totalRepositories as number) < 0 ||
    (totalRepositories as number) >
      GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES ||
    !installation ||
    !repositoryInputs
  ) {
    return undefined;
  }

  const repositories: GitHubInstallationRepositoryFixture[] = [];
  for (const inputRepository of repositoryInputs) {
    const repository = exactRecord(inputRepository, [
      "name",
      "owner",
      "repositoryId",
    ]);
    if (
      !repository ||
      typeof repository.repositoryId !== "string" ||
      typeof repository.owner !== "string" ||
      typeof repository.name !== "string"
    ) {
      return undefined;
    }
    repositories.push({
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      name: repository.name,
    });
  }

  return {
    pageIndex: pageIndex as number,
    cursor,
    nextCursor,
    totalRepositories: totalRepositories as number,
    installation,
    repositories,
  };
}

function parseInstallation(input: unknown): ParsedInstallation | undefined {
  const installation = exactRecord(input, [
    "installationId",
    "installationState",
    "permissions",
    "repositorySelection",
  ]);
  if (!installation) return undefined;
  const permissions = parsePermissions(installation.permissions);
  return typeof installation.installationId === "string" &&
      member(GITHUB_INSTALLATION_STATES, installation.installationState) &&
      member(
        GITHUB_REPOSITORY_SELECTIONS,
        installation.repositorySelection,
      ) &&
      permissions
    ? {
      installationId: installation.installationId,
      installationState: installation.installationState,
      repositorySelection: installation.repositorySelection,
      permissions,
    }
    : undefined;
}

function parsePermissions(
  input: unknown,
): GitHubInstallationPermissionFixture | undefined {
  const permissions = recordSnapshot(input);
  if (!permissions) return undefined;
  const names = Object.keys(permissions);
  if (
    names.length === 0 ||
    names.length > GITHUB_REPOSITORY_PERMISSION_NAMES.length ||
    names.some(
      (name) =>
        !GITHUB_REPOSITORY_PERMISSION_NAMES.includes(
          name as (typeof GITHUB_REPOSITORY_PERMISSION_NAMES)[number],
        ),
    )
  ) {
    return undefined;
  }

  const result: Record<string, "read" | "write"> = {};
  const declared = new Set(names);
  for (const name of GITHUB_REPOSITORY_PERMISSION_NAMES) {
    if (!declared.has(name)) continue;
    const access = permissions[name];
    if (
      !member(GITHUB_REPOSITORY_PERMISSION_ACCESS, access) ||
      (name === "metadata" && access !== "read")
    ) {
      return undefined;
    }
    result[name] = access;
  }
  return result.metadata === "read"
    ? result as GitHubInstallationPermissionFixture
    : undefined;
}

function sameInstallation(
  expected: ParsedInstallation,
  actual: ParsedInstallation,
): boolean {
  return expected.installationId === actual.installationId &&
    expected.installationState === actual.installationState &&
    expected.repositorySelection === actual.repositorySelection &&
    GITHUB_REPOSITORY_PERMISSION_NAMES.every(
      (name) => expected.permissions[name] === actual.permissions[name],
    );
}

function parseCursor(
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH
    ? value
    : undefined;
}

function exactRecord(
  input: unknown,
  expected: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const snapshot = recordSnapshot(input);
  if (!snapshot) return undefined;
  const actual = Object.keys(snapshot);
  return actual.length === expected.length &&
      actual.every((key) => expected.includes(key))
    ? snapshot
    : undefined;
}

function recordSnapshot(
  input: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) return undefined;

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactArray(input: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > maximum
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== (length as number) + 1 ||
    keys.at(-1) !== "length"
  ) {
    return undefined;
  }

  const values: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    if (keys[index] !== String(index)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    values.push(descriptor.value);
  }
  return values;
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
