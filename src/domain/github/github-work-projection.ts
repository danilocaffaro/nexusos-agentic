import type {
  GitHubIssueEvidence,
  GitHubLineageEdge,
  GitHubPullRequestEvidence,
  GitHubRepositoryInstallation,
} from "../../contracts/github-delivery";
import {
  parseGitHubDeliveryEvidence,
  parseGitHubLineageEdge,
  parseGitHubRepositoryInstallation,
} from "./github-delivery";
import {
  GITHUB_WORK_MAX_EVIDENCE,
  GITHUB_WORK_MAX_LINEAGE_EDGES,
  GITHUB_WORK_OBSERVATION_SPEC_VERSION,
  GITHUB_WORK_PROJECTION_SPEC_VERSION,
  type GitHubIssueWorkNode,
  type GitHubPullRequestWorkNode,
  type GitHubWorkItemProposal,
  type GitHubWorkProjection,
  type GitHubWorkProjectionLink,
} from "../../contracts/github-work-projection";

const MAX_GITHUB_NUMBER = 2_147_483_647;

export function githubWorkNodeRef(
  repositoryInput: unknown,
  kind: "issue" | "pull_request",
  number: number,
): string | undefined {
  try {
    const repository = stableRepository(repositoryInput);
    if (
      !repository ||
      (kind !== "issue" && kind !== "pull_request") ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > MAX_GITHUB_NUMBER
    ) return undefined;
    return `github:repository:${repository.repositoryId}:${kind}:${number}`;
  }
  catch {
    return undefined;
  }
}

export function projectGitHubWork(
  input: unknown,
): GitHubWorkProjection | undefined {
  try {
    const envelope = exactRecord(input, [
      "evidence",
      "lineage",
      "repository",
      "specVersion",
    ]);
    if (
      !envelope ||
      envelope.specVersion !== GITHUB_WORK_OBSERVATION_SPEC_VERSION
    ) return undefined;
    const repository = stableRepository(envelope.repository);
    const evidenceInput = exactArray(
      envelope.evidence,
      GITHUB_WORK_MAX_EVIDENCE,
    );
    const lineageInput = exactArray(
      envelope.lineage,
      GITHUB_WORK_MAX_LINEAGE_EDGES,
    );
    if (!repository || !evidenceInput || !lineageInput) return undefined;

    const issueByNumber = new Map<number, GitHubIssueEvidence>();
    const pullByNumber = new Map<number, GitHubPullRequestEvidence>();
    const issueIds = new Set<string>();
    const pullRequestIds = new Set<string>();
    let latestObservedAt: string | null = null;

    for (const candidate of evidenceInput) {
      const evidence = stableEvidence(candidate);
      if (
        !evidence ||
        (evidence.kind !== "issue" && evidence.kind !== "pull_request") ||
        !sameRepository(repository, evidence.repository) ||
        issueByNumber.has(evidence.number) ||
        pullByNumber.has(evidence.number)
      ) return undefined;
      if (evidence.kind === "issue") {
        if (issueIds.has(evidence.issueId)) return undefined;
        issueIds.add(evidence.issueId);
        issueByNumber.set(evidence.number, evidence);
      }
      else {
        if (pullRequestIds.has(evidence.pullRequestId)) return undefined;
        pullRequestIds.add(evidence.pullRequestId);
        pullByNumber.set(evidence.number, evidence);
      }
      if (latestObservedAt === null || evidence.observedAt > latestObservedAt) {
        latestObservedAt = evidence.observedAt;
      }
    }

    const links: GitHubWorkProjectionLink[] = [];
    const edgeKeys = new Set<string>();
    const trackedByIssue = new Map<number, string>();
    const issueByWorkItem = new Map<string, number>();
    for (const candidate of lineageInput) {
      const edge = stableLineageEdge(candidate);
      if (
        !edge ||
        !sameRepository(repository, edge.repository) ||
        (edge.relation !== "tracked_by" &&
          edge.relation !== "implemented_by")
      ) return undefined;
      const link = projectionLink(repository, edge);
      if (!link) return undefined;
      const edgeKey =
        `${link.relation}\u0000${link.sourceRef}\u0000${link.targetRef}`;
      if (edgeKeys.has(edgeKey)) return undefined;
      edgeKeys.add(edgeKey);
      if (link.relation === "tracked_by") {
        if (
          !issueByNumber.has(link.targetIssueNumber) ||
          trackedByIssue.has(link.targetIssueNumber) ||
          issueByWorkItem.has(link.sourceWorkItemId)
        ) return undefined;
        trackedByIssue.set(link.targetIssueNumber, link.sourceWorkItemId);
        issueByWorkItem.set(link.sourceWorkItemId, link.targetIssueNumber);
      }
      else if (
        !issueByNumber.has(link.sourceIssueNumber) ||
        !pullByNumber.has(link.targetPullRequestNumber)
      ) return undefined;
      links.push(link);
    }

    const nodes: Array<GitHubIssueWorkNode | GitHubPullRequestWorkNode> = [];
    const proposals: GitHubWorkItemProposal[] = [];
    for (const issue of issueByNumber.values()) {
      const ref = githubWorkNodeRef(repository, "issue", issue.number);
      if (!ref) return undefined;
      const trackedWorkItemId = trackedByIssue.get(issue.number) ?? null;
      const disposition = issue.state === "closed"
        ? "observed_only"
        : trackedWorkItemId
          ? "tracked"
          : "proposed";
      nodes.push({
        kind: "github_issue",
        ref,
        issueId: issue.issueId,
        number: issue.number,
        providerState: issue.state,
        updatedAt: issue.updatedAt,
        closedAt: issue.closedAt,
        observedAt: issue.observedAt,
        disposition,
        trackedWorkItemId,
      });
      if (disposition === "proposed") {
        proposals.push({
          claim: "proposal_only_no_import",
          issueRef: ref,
          issueId: issue.issueId,
          issueNumber: issue.number,
          suggestedExternalRef: ref,
          suggestedKind: "task",
          suggestedStatus: "backlog",
        });
      }
    }
    for (const pull of pullByNumber.values()) {
      const ref = githubWorkNodeRef(repository, "pull_request", pull.number);
      if (!ref) return undefined;
      nodes.push({
        kind: "github_pull_request",
        ref,
        pullRequestId: pull.pullRequestId,
        number: pull.number,
        providerState: pull.state,
        draft: pull.draft,
        headSha: pull.headSha,
        mergeSha: pull.mergeSha,
        updatedAt: pull.updatedAt,
        observedAt: pull.observedAt,
        disposition: "evidence_only",
      });
    }
    nodes.sort((left, right) => compareText(left.ref, right.ref));
    links.sort(compareLinks);
    proposals.sort((left, right) =>
      compareText(left.issueRef, right.issueRef)
    );
    return deepFreeze({
      specVersion: GITHUB_WORK_PROJECTION_SPEC_VERSION,
      repository,
      latestObservedAt,
      lineageClaim: "caller_asserted_unverified",
      nodes,
      links,
      proposals,
    });
  }
  catch {
    return undefined;
  }
}

function projectionLink(
  repository: GitHubRepositoryInstallation,
  edge: GitHubLineageEdge,
): GitHubWorkProjectionLink | undefined {
  if (
    edge.relation === "tracked_by" &&
    edge.source.kind === "nexus_work_item" &&
    edge.target.kind === "github_issue"
  ) {
    const targetRef = githubWorkNodeRef(
      repository,
      "issue",
      edge.target.number,
    );
    return targetRef
      ? {
          relation: edge.relation,
          sourceRef: `nexus:work_item:${edge.source.id}`,
          sourceWorkItemId: edge.source.id,
          targetRef,
          targetIssueNumber: edge.target.number,
          recordedAt: edge.recordedAt,
        }
      : undefined;
  }
  if (
    edge.relation === "implemented_by" &&
    edge.source.kind === "github_issue" &&
    edge.target.kind === "github_pull_request"
  ) {
    const sourceRef = githubWorkNodeRef(
      repository,
      "issue",
      edge.source.number,
    );
    const targetRef = githubWorkNodeRef(
      repository,
      "pull_request",
      edge.target.number,
    );
    return sourceRef && targetRef
      ? {
          relation: edge.relation,
          sourceRef,
          sourceIssueNumber: edge.source.number,
          targetRef,
          targetPullRequestNumber: edge.target.number,
          recordedAt: edge.recordedAt,
        }
      : undefined;
  }
  return undefined;
}

function sameRepository(
  left: GitHubRepositoryInstallation,
  right: GitHubRepositoryInstallation,
): boolean {
  return left.installationId === right.installationId &&
    left.repositoryId === right.repositoryId &&
    left.owner === right.owner &&
    left.name === right.name;
}

function stableRepository(
  input: unknown,
): GitHubRepositoryInstallation | undefined {
  const captured = parseGitHubRepositoryInstallation(input);
  return captured
    ? parseGitHubRepositoryInstallation(captured)
    : undefined;
}

function stableEvidence(
  input: unknown,
): GitHubIssueEvidence | GitHubPullRequestEvidence | undefined {
  const captured = parseGitHubDeliveryEvidence(input);
  if (!captured) return undefined;
  const stable = parseGitHubDeliveryEvidence(captured);
  return stable?.kind === "issue" || stable?.kind === "pull_request"
    ? stable
    : undefined;
}

function stableLineageEdge(input: unknown): GitHubLineageEdge | undefined {
  const captured = parseGitHubLineageEdge(input);
  return captured ? parseGitHubLineageEdge(captured) : undefined;
}

function exactRecord(
  input: unknown,
  expected: readonly string[],
): Record<string, unknown> | undefined {
  const prototype = input && typeof input === "object"
    ? Object.getPrototypeOf(input)
    : undefined;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (prototype !== Object.prototype && prototype !== null)
  ) return undefined;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(input: unknown, limit: number): unknown[] | undefined {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable !== false ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > limit
  ) return undefined;
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length + 1 || !keys.includes("length")) return undefined;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function compareLinks(
  left: GitHubWorkProjectionLink,
  right: GitHubWorkProjectionLink,
): number {
  return compareText(left.relation, right.relation) ||
    compareText(left.sourceRef, right.sourceRef) ||
    compareText(left.targetRef, right.targetRef);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value;
}
