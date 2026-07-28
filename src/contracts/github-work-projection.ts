import type {
  GitHubDeliveryEvidence,
  GitHubLineageEdge,
  GitHubRepositoryInstallation,
} from "./github-delivery";
import type {
  WorkItemKind,
  WorkItemStatus,
} from "@/src/contracts/work-graph";

export const GITHUB_WORK_OBSERVATION_SPEC_VERSION =
  "nexusos.github-work-observation.v1" as const;
export const GITHUB_WORK_PROJECTION_SPEC_VERSION =
  "nexusos.github-work-projection.v1" as const;
export const GITHUB_WORK_MAX_EVIDENCE = 500;
export const GITHUB_WORK_MAX_LINEAGE_EDGES = 500;

export type GitHubWorkObservation = Readonly<{
  specVersion: typeof GITHUB_WORK_OBSERVATION_SPEC_VERSION;
  repository: GitHubRepositoryInstallation;
  evidence: readonly GitHubDeliveryEvidence[];
  lineage: readonly GitHubLineageEdge[];
}>;

export type GitHubIssueWorkNode = Readonly<{
  kind: "github_issue";
  ref: string;
  issueId: string;
  number: number;
  providerState: "open" | "closed";
  updatedAt: string;
  closedAt: string | null;
  observedAt: string;
  disposition: "proposed" | "tracked" | "observed_only";
  trackedWorkItemId: string | null;
}>;

export type GitHubPullRequestWorkNode = Readonly<{
  kind: "github_pull_request";
  ref: string;
  pullRequestId: string;
  number: number;
  providerState: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  mergeSha: string | null;
  updatedAt: string;
  observedAt: string;
  disposition: "evidence_only";
}>;

export type GitHubWorkNode =
  | GitHubIssueWorkNode
  | GitHubPullRequestWorkNode;

export type GitHubWorkProjectionLink =
  | Readonly<{
      relation: "tracked_by";
      sourceRef: string;
      sourceWorkItemId: string;
      targetRef: string;
      targetIssueNumber: number;
      recordedAt: string;
    }>
  | Readonly<{
      relation: "implemented_by";
      sourceRef: string;
      sourceIssueNumber: number;
      targetRef: string;
      targetPullRequestNumber: number;
      recordedAt: string;
    }>;

export type GitHubWorkItemProposal = Readonly<{
  claim: "proposal_only_no_import";
  issueRef: string;
  issueId: string;
  issueNumber: number;
  suggestedExternalRef: string;
  suggestedKind: Extract<WorkItemKind, "task">;
  suggestedStatus: Extract<WorkItemStatus, "backlog">;
}>;

export type GitHubWorkProjection = Readonly<{
  specVersion: typeof GITHUB_WORK_PROJECTION_SPEC_VERSION;
  repository: GitHubRepositoryInstallation;
  latestObservedAt: string | null;
  lineageClaim: "caller_asserted_unverified";
  nodes: readonly GitHubWorkNode[];
  links: readonly GitHubWorkProjectionLink[];
  proposals: readonly GitHubWorkItemProposal[];
}>;
