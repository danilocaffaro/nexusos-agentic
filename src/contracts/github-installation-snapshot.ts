export const GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION =
  "nexusos.github-installation-snapshot-page.v1" as const;

export const GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS = 500 as const;

export const GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH = 1024 as const;

export type GitHubInstallationSnapshotPageInput = Readonly<{
  pageIndex: number;
  cursor: string | null;
}>;

export type GitHubInstallationSnapshotTransport = Readonly<{
  readPage: (
    this: void,
    pageInput: GitHubInstallationSnapshotPageInput,
  ) => Promise<unknown>;
}>;
