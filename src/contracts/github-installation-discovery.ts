import type {
  GitHubInstallationSnapshotTransport,
} from "./github-installation-snapshot";

export const GITHUB_INSTALLATION_DISCOVERY_API_ORIGIN =
  "https://api.github.com" as const;

export const GITHUB_INSTALLATION_DISCOVERY_API_VERSION =
  "2026-03-10" as const;

export const GITHUB_INSTALLATION_DISCOVERY_USER_AGENT =
  "NexusOS-GitHub-Installation-Discovery/1" as const;

export const GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE = 100 as const;

export const GITHUB_INSTALLATION_DISCOVERY_MAX_REPOSITORY_PAGES = 5 as const;

export const GITHUB_INSTALLATION_DISCOVERY_MAX_HTTP_CALLS = 7 as const;

export const GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES =
  2 * 1024 * 1024;

export const GITHUB_INSTALLATION_DISCOVERY_REQUEST_TIMEOUT_MS = 10_000 as const;

export const GITHUB_INSTALLATION_DISCOVERY_TOTAL_TIMEOUT_MS = 45_000 as const;

export const GITHUB_INSTALLATION_DISCOVERY_LEASE_SKEW_MS = 60_000 as const;

export const GITHUB_INSTALLATION_DISCOVERY_LEASE_KINDS = [
  "app-jwt",
  "installation-token",
] as const;

export const GITHUB_INSTALLATION_DISCOVERY_ERROR_CODES = [
  "invalid_input",
  "lease_kind_mismatch",
  "lease_installation_mismatch",
  "lease_expired",
  "lease_unavailable",
  "lease_release_failed",
  "sequence_violation",
  "call_cap_exceeded",
  "deadline_exceeded",
  "network_failure",
  "redirect_rejected",
  "body_too_large",
  "response_stream_failure",
  "malformed_response",
  "api_version_unsupported",
  "authentication_rejected",
  "rate_limited",
  "installation_not_found",
  "installation_suspended",
  "missing_metadata_read",
  "unsupported_permission",
  "repository_overflow",
  "total_count_drift",
  "page_length_mismatch",
  "duplicate_repository",
  "metadata_drift",
  "upstream_failure",
  "unexpected_status",
] as const;

type Member<T extends readonly string[]> = T[number];

export type GitHubInstallationDiscoveryLeaseKind =
  Member<typeof GITHUB_INSTALLATION_DISCOVERY_LEASE_KINDS>;

export type GitHubInstallationDiscoveryErrorCode =
  Member<typeof GITHUB_INSTALLATION_DISCOVERY_ERROR_CODES>;

export type GitHubInstallationDiscoveryCredentialLease = Readonly<{
  kind: GitHubInstallationDiscoveryLeaseKind;
  installationId: string;
  expiresAtEpochMs: number;
  reveal(this: void): string;
  release(this: void): void;
}>;

export type GitHubInstallationDiscoveryInput = Readonly<{
  installationId: string;
  appJwt: GitHubInstallationDiscoveryCredentialLease;
  installationToken: GitHubInstallationDiscoveryCredentialLease;
}>;

export type GitHubInstallationDiscoveryRateLimit = Readonly<{
  limit: number | undefined;
  remaining: number | undefined;
  resetAtEpochSeconds: number | undefined;
  retryAfterSeconds: number | undefined;
}>;

export type GitHubInstallationDiscoveryHttpObservation = Readonly<{
  requestKind: "installation" | "repositories";
  status: number;
  rateLimit: GitHubInstallationDiscoveryRateLimit;
}>;

export class GitHubInstallationDiscoveryError extends Error {
  readonly code: GitHubInstallationDiscoveryErrorCode;
  readonly status: number | undefined;
  readonly rateLimit: GitHubInstallationDiscoveryRateLimit | undefined;

  constructor(
    code: GitHubInstallationDiscoveryErrorCode,
    details: Readonly<{
      status?: number;
      rateLimit?: GitHubInstallationDiscoveryRateLimit;
    }> = {},
  ) {
    super(code);
    this.name = "GitHubInstallationDiscoveryError";
    this.code = code;
    this.status = details.status;
    this.rateLimit = details.rateLimit;
  }

  toJSON(): Readonly<{
    name: "GitHubInstallationDiscoveryError";
    code: GitHubInstallationDiscoveryErrorCode;
    status: number | undefined;
    rateLimit: GitHubInstallationDiscoveryRateLimit | undefined;
  }> {
    return {
      name: "GitHubInstallationDiscoveryError",
      code: this.code,
      status: this.status,
      rateLimit: this.rateLimit,
    };
  }
}

export type GitHubInstallationDiscoveryTransport =
  GitHubInstallationSnapshotTransport;
