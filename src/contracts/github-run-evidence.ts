import type {
  GitHubCheckRunEvidence,
  GitHubDeploymentEvidence,
  GitHubRepositoryInstallation,
} from "./github-delivery";
import type {
  GitHubWorkObservation,
} from "./github-work-projection";

export const GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION =
  "nexusos.github-run-evidence-observation.v1" as const;
export const GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION =
  "nexusos.github-run-evidence-projection.v1" as const;
export const GITHUB_RUN_EVIDENCE_MAX_ITEMS = 500;

export type GitHubRunEvidenceObservation = Readonly<{
  specVersion: typeof GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION;
  work: GitHubWorkObservation;
  runEvidence: readonly (
    | GitHubCheckRunEvidence
    | GitHubDeploymentEvidence
  )[];
}>;

export type GitHubProjectedCheckRun = Readonly<{
  kind: "github_check_run";
  checkRunId: string;
  name: string;
  providerStatus: GitHubCheckRunEvidence["status"];
  providerConclusion: GitHubCheckRunEvidence["conclusion"];
  startedAt: string | null;
  completedAt: string | null;
  observedAt: string;
}>;

export type GitHubProjectedDeploymentStatus = Readonly<{
  kind: "github_deployment_status";
  deploymentId: string;
  deploymentStatusId: string;
  environment: string;
  providerState: GitHubDeploymentEvidence["state"];
  deploymentCreatedAt: string;
  statusCreatedAt: string;
  observedAt: string;
}>;

export type GitHubCommitPullRequest = Readonly<{
  number: number;
  ref: string;
}>;

export type GitHubCommitRunEvidence = Readonly<{
  kind: "git_commit";
  headSha: string;
  pullRequests: readonly GitHubCommitPullRequest[];
  checkRuns: readonly GitHubProjectedCheckRun[];
  deploymentStatuses: readonly GitHubProjectedDeploymentStatus[];
}>;

export type GitHubRunEvidenceProjection = Readonly<{
  specVersion: typeof GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION;
  repository: GitHubRepositoryInstallation;
  latestRunObservedAt: string | null;
  evidenceClaim: "observed_only_no_authority";
  commits: readonly GitHubCommitRunEvidence[];
}>;
