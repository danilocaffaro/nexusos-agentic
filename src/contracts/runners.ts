export const RUNNER_TRUST_PROFILE = "operator_trust" as const;

export const RUNNER_TRUST_DISCLOSURE =
  "This runner executes on infrastructure you control. NexusOS verifies its cryptographic identity and liveness only; it does not yet sandbox, inspect or supervise local execution. Anyone holding the private key can act as this runner. Revoke it immediately if the host is compromised.";

export type RunnerTrustProfile = typeof RUNNER_TRUST_PROFILE;

export type RunnerLiveness =
  | "pending"
  | "online"
  | "stale"
  | "offline"
  | "revoked";

export type RunnerCapabilityName =
  | "node_permission_model"
  | "bubblewrap"
  | "landlock"
  | "seccomp"
  | "user_namespace"
  | "docker"
  | "podman";

export type RunnerAdmissionPolicy = {
  version: number;
  source: "default" | "configured";
  capabilityFreshnessSeconds: number;
  engineFreshnessSeconds: number;
  allowedCapabilities: RunnerCapabilityName[];
  updatedAt?: string;
  updatedBy?: string;
};

export type RunnerAdmissionPolicyResponse = {
  policy: RunnerAdmissionPolicy;
  viewerCanEditPolicy: boolean;
};

export type RunnerDeclarationAdmissionFreshness =
  | "fresh"
  | "stale"
  | "future"
  | "absent"
  | "not_evaluated";

export type RunnerDeclarationAdmissionReason =
  | "satisfied"
  | "invalid_policy"
  | "capability_disallowed"
  | "declaration_absent"
  | "declaration_future"
  | "capability_absent"
  | "capability_unavailable"
  | "capability_unknown"
  | "declaration_stale";

export type RunnerDeclarationAdmission = {
  evaluatedAt: string;
  policySource: "default" | "configured";
  policyVersion: number;
  freshnessSeconds: number;
  freshnessState: RunnerDeclarationAdmissionFreshness;
  reportId: string | null;
  reportReceivedAt: string | null;
  freshUntil: string | null;
  capabilities: Array<{
    capability: RunnerCapabilityName;
    allowed: boolean;
    declaredStatus: "available" | "unavailable" | "unknown" | null;
    declarationSatisfied: boolean;
    reason: RunnerDeclarationAdmissionReason;
  }>;
};

export type RunnerDeclaredCapability = {
  capability: RunnerCapabilityName;
  status: "available" | "unavailable" | "unknown";
  detection:
    | "node_flag"
    | "binary_version"
    | "proc_read"
    | "syscall"
    | "none";
  reasonCode:
    | "none"
    | "not_found"
    | "not_supported"
    | "permission_denied"
    | "probe_disabled"
    | "unknown";
  version?: string;
};

export type RunnerCapabilityReportView = {
  reportId: string;
  schemaVersion: 1;
  trust: "hostReported";
  collectedAt: string;
  receivedAt: string;
  ageSeconds: number;
  platform: {
    os: string;
    arch: string;
    nodeVersion: string;
  };
  truncated: boolean;
  capabilities: RunnerDeclaredCapability[];
};

export type RunnerCapabilityReportPage = {
  runnerId: string;
  trustDisclosure: string;
  reports: RunnerCapabilityReportView[];
  nextCursor: string | null;
};

export const RUNNER_CAPABILITY_TRUST_DISCLOSURE =
  "Capability reports are evidence supplied by the operator-controlled host. They support routing and diagnostics, not containment. NexusOS does not run user work under an enforced sandbox in this version.";

export type Runner = {
  id: string;
  organizationId: string;
  principalId: string;
  displayName: string;
  publicKey: string;
  publicKeyFingerprint: string;
  trustProfile: RunnerTrustProfile;
  trustDisclosure: string;
  status: "active" | "revoked";
  liveness: RunnerLiveness;
  enrolledAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  declaredCapabilities: RunnerCapabilityReportView | null;
  declarationAdmission: RunnerDeclarationAdmission;
};

export type RunnerEnrollmentToken = {
  tokenId: string;
  token: string;
  expiresAt: string;
};

export type RunnerEnrollment = {
  runnerId: string;
  principalId: string;
  organizationId: string;
  enrolledAt: string;
  trustProfile: RunnerTrustProfile;
};

export type RunnerHeartbeat = {
  status: "active";
  observedAt: string;
  nextHeartbeatSeconds: 30;
};

export type RunnerRegistry = {
  runners: Runner[];
  admissionPolicy: RunnerAdmissionPolicy;
  audience: string;
  trustDisclosure: string;
  capabilities: {
    identity: "real";
    heartbeat: "real";
    leases: "real";
    durableReplay: "real";
    capabilityProfiles: "real";
    execution: "roadmap";
    sandbox: "roadmap";
    streaming: "roadmap";
  };
  capabilityDisclosure: string;
};
