import type {
  GitHubCheckRunEvidence,
  GitHubDeploymentEvidence,
  GitHubRepositoryInstallation,
} from "../../contracts/github-delivery";
import {
  GITHUB_RUN_EVIDENCE_MAX_ITEMS,
  GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION,
  GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION,
  type GitHubProjectedCheckRun,
  type GitHubProjectedDeploymentStatus,
  type GitHubRunEvidenceProjection,
} from "../../contracts/github-run-evidence";
import {
  type GitHubPullRequestWorkNode,
} from "../../contracts/github-work-projection";
import {
  parseGitHubDeliveryEvidence,
} from "./github-delivery";
import {
  projectGitHubWork,
} from "./github-work-projection";

type MutableCommit = {
  kind: "git_commit";
  headSha: string;
  pullRequests: Array<{ number: number; ref: string }>;
  checkRuns: GitHubProjectedCheckRun[];
  deploymentStatuses: GitHubProjectedDeploymentStatus[];
};

export function projectGitHubRunEvidence(
  input: unknown,
): GitHubRunEvidenceProjection | undefined {
  try {
    const envelope = exactRecord(input, [
      "runEvidence",
      "specVersion",
      "work",
    ]);
    if (
      !envelope ||
      envelope.specVersion !== GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION
    ) return undefined;
    const work = projectGitHubWork(envelope.work);
    const evidenceInput = exactArray(
      envelope.runEvidence,
      GITHUB_RUN_EVIDENCE_MAX_ITEMS,
    );
    if (!work || !evidenceInput) return undefined;

    const commits = new Map<string, MutableCommit>();
    for (const node of work.nodes) {
      if (node.kind !== "github_pull_request") continue;
      const commit = commits.get(node.headSha) ?? newCommit(node);
      commit.pullRequests.push({ number: node.number, ref: node.ref });
      commits.set(node.headSha, commit);
    }

    const checkRunIds = new Set<string>();
    const deploymentStatusIds = new Set<string>();
    const deployments = new Map<string, {
      environment: string;
      commitSha: string;
      deploymentCreatedAt: string;
    }>();
    let latestRunObservedAt: string | null = null;
    for (const candidate of evidenceInput) {
      const evidence = stableRunEvidence(candidate);
      if (
        !evidence ||
        !sameRepository(work.repository, evidence.repository)
      ) return undefined;
      const sha = evidence.kind === "check_run"
        ? evidence.headSha
        : evidence.commitSha;
      const commit = commits.get(sha);
      if (!commit) return undefined;

      if (evidence.kind === "check_run") {
        if (checkRunIds.has(evidence.checkRunId)) return undefined;
        checkRunIds.add(evidence.checkRunId);
        commit.checkRuns.push(projectCheckRun(evidence));
      }
      else {
        if (deploymentStatusIds.has(evidence.deploymentStatusId)) {
          return undefined;
        }
        deploymentStatusIds.add(evidence.deploymentStatusId);
        const known = deployments.get(evidence.deploymentId);
        if (
          known &&
          (
            known.environment !== evidence.environment ||
            known.commitSha !== evidence.commitSha ||
            known.deploymentCreatedAt !== evidence.deploymentCreatedAt
          )
        ) return undefined;
        deployments.set(evidence.deploymentId, {
          environment: evidence.environment,
          commitSha: evidence.commitSha,
          deploymentCreatedAt: evidence.deploymentCreatedAt,
        });
        commit.deploymentStatuses.push(projectDeploymentStatus(evidence));
      }
      if (
        latestRunObservedAt === null ||
        evidence.observedAt > latestRunObservedAt
      ) latestRunObservedAt = evidence.observedAt;
    }

    const ordered = [...commits.values()];
    for (const commit of ordered) {
      commit.pullRequests.sort((left, right) => left.number - right.number);
      commit.checkRuns.sort((left, right) =>
        compareDecimalId(left.checkRunId, right.checkRunId)
      );
      commit.deploymentStatuses.sort((left, right) =>
        compareDecimalId(left.deploymentId, right.deploymentId) ||
        compareDecimalId(
          left.deploymentStatusId,
          right.deploymentStatusId,
        )
      );
    }
    ordered.sort((left, right) => compareText(left.headSha, right.headSha));

    return deepFreeze({
      specVersion: GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION,
      repository: work.repository,
      latestRunObservedAt,
      evidenceClaim: "observed_only_no_authority",
      commits: ordered,
    });
  }
  catch {
    return undefined;
  }
}

function newCommit(node: GitHubPullRequestWorkNode): MutableCommit {
  return {
    kind: "git_commit",
    headSha: node.headSha,
    pullRequests: [],
    checkRuns: [],
    deploymentStatuses: [],
  };
}

function stableRunEvidence(
  input: unknown,
): GitHubCheckRunEvidence | GitHubDeploymentEvidence | undefined {
  const captured = parseGitHubDeliveryEvidence(input);
  if (!captured) return undefined;
  const stable = parseGitHubDeliveryEvidence(captured);
  return stable?.kind === "check_run" || stable?.kind === "deployment"
    ? stable
    : undefined;
}

function projectCheckRun(
  evidence: GitHubCheckRunEvidence,
): GitHubProjectedCheckRun {
  return {
    kind: "github_check_run",
    checkRunId: evidence.checkRunId,
    name: evidence.name,
    providerStatus: evidence.status,
    providerConclusion: evidence.conclusion,
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    observedAt: evidence.observedAt,
  };
}

function projectDeploymentStatus(
  evidence: GitHubDeploymentEvidence,
): GitHubProjectedDeploymentStatus {
  return {
    kind: "github_deployment_status",
    deploymentId: evidence.deploymentId,
    deploymentStatusId: evidence.deploymentStatusId,
    environment: evidence.environment,
    providerState: evidence.state,
    deploymentCreatedAt: evidence.deploymentCreatedAt,
    statusCreatedAt: evidence.statusCreatedAt,
    observedAt: evidence.observedAt,
  };
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
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(input: unknown, limit: number): unknown[] | undefined {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) return undefined;
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
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) return undefined;
    copy.push(descriptor.value);
  }
  return copy;
}

function compareDecimalId(left: string, right: string): number {
  return left.length - right.length || compareText(left, right);
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
