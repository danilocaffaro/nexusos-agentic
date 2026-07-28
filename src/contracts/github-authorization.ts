import type { GitHubRepositoryInstallation } from "./github-delivery";

export const GITHUB_AUTHORIZATION_SPEC_VERSION =
  "nexusos.github-installation-scope.v1" as const;

export const GITHUB_INSTALLATION_STATES = [
  "active",
  "suspended",
] as const;

export const GITHUB_REPOSITORY_SELECTIONS = [
  "all",
  "selected",
] as const;

// This order is the canonical wire order for permission grants.
export const GITHUB_REPOSITORY_PERMISSION_NAMES = [
  "metadata",
  "issues",
  "pull_requests",
  "checks",
  "deployments",
  "contents",
] as const;

export const GITHUB_REPOSITORY_PERMISSION_ACCESS = [
  "read",
  "write",
] as const;

type Member<T extends readonly string[]> = T[number];

export type GitHubRepositoryPermissionName =
  Member<typeof GITHUB_REPOSITORY_PERMISSION_NAMES>;

export type GitHubRepositoryPermissionAccess =
  Member<typeof GITHUB_REPOSITORY_PERMISSION_ACCESS>;

export type GitHubRepositoryPermissionGrant =
  | {
    name: "metadata";
    access: "read";
  }
  | {
    name: Exclude<GitHubRepositoryPermissionName, "metadata">;
    access: GitHubRepositoryPermissionAccess;
  };

export type GitHubInstallationScope = {
  specVersion: typeof GITHUB_AUTHORIZATION_SPEC_VERSION;
  installationState: Member<typeof GITHUB_INSTALLATION_STATES>;
  // Records how GitHub selected access. Authority is bound by `repository`.
  repositorySelection: Member<typeof GITHUB_REPOSITORY_SELECTIONS>;
  repository: GitHubRepositoryInstallation;
  permissions: readonly GitHubRepositoryPermissionGrant[];
};
