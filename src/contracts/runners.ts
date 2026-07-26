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
  audience: string;
  trustDisclosure: string;
  capabilities: {
    identity: "real";
    heartbeat: "real";
    leases: "real";
    durableReplay: "real";
    execution: "roadmap";
    sandbox: "roadmap";
    streaming: "roadmap";
  };
};
