import type {
  GitHubInstallationScope,
  GitHubRepositoryPermissionAccess,
  GitHubRepositoryPermissionName,
} from "./github-authorization";
import type { GitHubRepositoryInstallation } from "./github-delivery";

export const GITHUB_INSTALLATION_SOURCE_SPEC_VERSION =
  "nexusos.github-installation-source-fixture.v1" as const;

export const GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES = 500 as const;

export type GitHubInstallationPermissionFixture = Readonly<
  { metadata: "read" } & Partial<
    Record<
      Exclude<GitHubRepositoryPermissionName, "metadata">,
      GitHubRepositoryPermissionAccess
    >
  >
>;

export type GitHubInstallationRepositoryFixture = {
  repositoryId: string;
  owner: string;
  name: string;
};

export type GitHubInstallationSourceFixture = {
  specVersion: typeof GITHUB_INSTALLATION_SOURCE_SPEC_VERSION;
  installationId: string;
  installationState: GitHubInstallationScope["installationState"];
  repositorySelection: GitHubInstallationScope["repositorySelection"];
  permissions: GitHubInstallationPermissionFixture;
  repositories: readonly GitHubInstallationRepositoryFixture[];
};

export type GitHubInstallationScopeLookup = Pick<
  GitHubRepositoryInstallation,
  "installationId" | "repositoryId"
>;

export type GitHubInstallationScopeSource = Readonly<{
  readScope(
    lookup: GitHubInstallationScopeLookup,
  ): Promise<GitHubInstallationScope | undefined>;
}>;
