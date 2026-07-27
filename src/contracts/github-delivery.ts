export const GITHUB_ISSUE_STATES = ["open", "closed"] as const;
export const GITHUB_PULL_REQUEST_STATES = [
  "open",
  "closed",
  "merged",
] as const;
export const GITHUB_CHECK_STATUSES = [
  "queued",
  "in_progress",
  "completed",
] as const;
export const GITHUB_CHECK_CONCLUSIONS = [
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
] as const;
export const GITHUB_DEPLOYMENT_STATES = [
  "error",
  "failure",
  "inactive",
  "in_progress",
  "queued",
  "pending",
  "success",
] as const;
export const GITHUB_LINEAGE_RELATIONS = [
  "tracked_by",
  "implemented_by",
  "head_commit",
  "verifies",
  "deploys",
] as const;
export const GITHUB_EFFECT_ACTION_TYPES = [
  "github.issue.create",
  "github.issue.update",
  "github.pull_request.create",
  "github.pull_request.request_review",
  "github.pull_request.merge",
  "github.deployment.promote",
] as const;

type Member<T extends readonly string[]> = T[number];

export type GitHubRepositoryInstallation = {
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
};

type GitHubEvidenceBase = {
  repository: GitHubRepositoryInstallation;
  observedAt: string;
};

export type GitHubIssueEvidence = GitHubEvidenceBase & {
  kind: "issue";
  issueId: string;
  number: number;
  state: Member<typeof GITHUB_ISSUE_STATES>;
  updatedAt: string;
  closedAt: string | null;
};

export type GitHubPullRequestEvidence = GitHubEvidenceBase & {
  kind: "pull_request";
  pullRequestId: string;
  number: number;
  state: Member<typeof GITHUB_PULL_REQUEST_STATES>;
  draft: boolean;
  headSha: string;
  mergeSha: string | null;
  updatedAt: string;
};

export type GitHubCheckRunEvidence = GitHubEvidenceBase & {
  kind: "check_run";
  checkRunId: string;
  name: string;
  headSha: string;
  status: Member<typeof GITHUB_CHECK_STATUSES>;
  conclusion: Member<typeof GITHUB_CHECK_CONCLUSIONS> | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type GitHubDeploymentEvidence = GitHubEvidenceBase & {
  kind: "deployment";
  deploymentId: string;
  deploymentStatusId: string;
  environment: string;
  commitSha: string;
  state: Member<typeof GITHUB_DEPLOYMENT_STATES>;
  deploymentCreatedAt: string;
  statusCreatedAt: string;
};

export type GitHubDeliveryEvidence =
  | GitHubIssueEvidence
  | GitHubPullRequestEvidence
  | GitHubCheckRunEvidence
  | GitHubDeploymentEvidence;

export type GitHubLineageSubject =
  | { kind: "nexus_work_item"; id: string }
  | { kind: "github_issue"; number: number }
  | { kind: "github_pull_request"; number: number }
  | { kind: "git_commit"; sha: string }
  | { kind: "github_check_run"; id: string }
  | { kind: "github_deployment"; id: string };

export type GitHubLineageEdge = {
  repository: GitHubRepositoryInstallation;
  source: GitHubLineageSubject;
  relation: Member<typeof GITHUB_LINEAGE_RELATIONS>;
  target: GitHubLineageSubject;
  recordedAt: string;
};

export type GitHubEffectTarget =
  | { kind: "repository" }
  | { kind: "issue"; number: number }
  | { kind: "pull_request"; number: number };

export type GitHubEffectIntentDescriptor = {
  actionType: Member<typeof GITHUB_EFFECT_ACTION_TYPES>;
  repository: GitHubRepositoryInstallation;
  target: GitHubEffectTarget;
};
