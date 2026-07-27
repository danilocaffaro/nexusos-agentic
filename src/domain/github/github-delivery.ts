import type {
  GitHubCheckRunEvidence,
  GitHubDeliveryEvidence,
  GitHubDeploymentEvidence,
  GitHubEffectIntentDescriptor,
  GitHubEffectTarget,
  GitHubIssueEvidence,
  GitHubLineageEdge,
  GitHubLineageSubject,
  GitHubPullRequestEvidence,
  GitHubRepositoryInstallation,
} from "../../contracts/github-delivery";
import {
  GITHUB_CHECK_CONCLUSIONS,
  GITHUB_CHECK_STATUSES,
  GITHUB_DEPLOYMENT_STATES,
  GITHUB_EFFECT_ACTION_TYPES,
  GITHUB_ISSUE_STATES,
  GITHUB_LINEAGE_RELATIONS,
  GITHUB_PULL_REQUEST_STATES,
} from "../../contracts/github-delivery";

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const MAX_GITHUB_ID = "9223372036854775807";
const MAX_GITHUB_NUMBER = 2_147_483_647;
const LOGIN =
  /^(?=.{1,39}$)(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const REPOSITORY_NAME = /^(?=.{1,100}$)[a-z0-9._-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const WORK_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function parseGitHubRepositoryInstallation(
  input: unknown,
): GitHubRepositoryInstallation | undefined {
  const value = record(input);
  if (
    !value ||
    !keys(value, ["installationId", "name", "owner", "repositoryId"])
  ) return undefined;
  const owner = asciiLower(value.owner);
  const name = asciiLower(value.name);
  if (
    !decimalId(value.installationId) ||
    !decimalId(value.repositoryId) ||
    owner === undefined ||
    !LOGIN.test(owner) ||
    name === undefined ||
    !REPOSITORY_NAME.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return undefined;
  }
  return {
    installationId: value.installationId,
    repositoryId: value.repositoryId,
    owner,
    name,
  };
}

export function parseGitHubDeliveryEvidence(
  input: unknown,
): GitHubDeliveryEvidence | undefined {
  const value = record(input);
  if (!value) return undefined;
  switch (ownData(value, "kind")) {
    case "issue":
      return issueEvidence(value);
    case "pull_request":
      return pullRequestEvidence(value);
    case "check_run":
      return checkRunEvidence(value);
    case "deployment":
      return deploymentEvidence(value);
    default:
      return undefined;
  }
}

export function parseGitHubLineageEdge(
  input: unknown,
): GitHubLineageEdge | undefined {
  const value = record(input);
  if (
    !value ||
    !keys(value, ["recordedAt", "relation", "repository", "source", "target"]) ||
    !member(GITHUB_LINEAGE_RELATIONS, value.relation) ||
    !timestamp(value.recordedAt)
  ) {
    return undefined;
  }
  const repository = parseGitHubRepositoryInstallation(value.repository);
  const source = lineageSubject(value.source);
  const target = lineageSubject(value.target);
  if (!repository || !source || !target || !validLineage(value.relation, source, target)) {
    return undefined;
  }
  return {
    repository,
    source,
    relation: value.relation,
    target,
    recordedAt: value.recordedAt,
  };
}

export function parseGitHubEffectIntentDescriptor(
  input: unknown,
): GitHubEffectIntentDescriptor | undefined {
  const value = record(input);
  if (
    !value ||
    !keys(value, ["actionType", "repository", "target"]) ||
    !member(GITHUB_EFFECT_ACTION_TYPES, value.actionType)
  ) {
    return undefined;
  }
  const repository = parseGitHubRepositoryInstallation(value.repository);
  const target = effectTarget(value.target);
  if (!repository || !target || !validEffectTarget(value.actionType, target.kind)) {
    return undefined;
  }
  return { actionType: value.actionType, repository, target };
}

export function githubEffectTargetRef(
  descriptor: GitHubEffectIntentDescriptor,
): string {
  const parsed = parseGitHubEffectIntentDescriptor(descriptor);
  if (!parsed) throw new TypeError("Invalid GitHub effect intent descriptor.");
  const root =
    `github:installation:${parsed.repository.installationId}` +
    `:repository:${parsed.repository.repositoryId}`;
  return parsed.target.kind === "repository"
    ? root
    : `${root}:${parsed.target.kind}:${parsed.target.number}`;
}

function issueEvidence(value: Record<string, unknown>): GitHubIssueEvidence | undefined {
  if (
    !keys(value, ["closedAt", "issueId", "kind", "number", "observedAt", "repository", "state", "updatedAt"]) ||
    !decimalId(value.issueId) ||
    !positiveNumber(value.number) ||
    !member(GITHUB_ISSUE_STATES, value.state) ||
    !timestamp(value.updatedAt) ||
    !timestamp(value.observedAt) ||
    !nullableTimestamp(value.closedAt) ||
    (value.state === "open") !== (value.closedAt === null) ||
    !atOrBefore(value.updatedAt, value.observedAt) ||
    (value.closedAt !== null && !atOrBefore(value.closedAt, value.updatedAt))
  ) return undefined;
  const repository = parseGitHubRepositoryInstallation(value.repository);
  return repository ? { ...value, repository } as GitHubIssueEvidence : undefined;
}

function pullRequestEvidence(
  value: Record<string, unknown>,
): GitHubPullRequestEvidence | undefined {
  if (
    !keys(value, ["draft", "headSha", "kind", "mergeSha", "number", "observedAt", "pullRequestId", "repository", "state", "updatedAt"]) ||
    !decimalId(value.pullRequestId) ||
    !positiveNumber(value.number) ||
    !member(GITHUB_PULL_REQUEST_STATES, value.state) ||
    typeof value.draft !== "boolean" ||
    !sha(value.headSha) ||
    !(value.mergeSha === null || sha(value.mergeSha)) ||
    !timestamp(value.updatedAt) ||
    !timestamp(value.observedAt) ||
    (value.state === "merged") !== (value.mergeSha !== null) ||
    (value.state === "merged" && value.draft) ||
    !atOrBefore(value.updatedAt, value.observedAt)
  ) return undefined;
  const repository = parseGitHubRepositoryInstallation(value.repository);
  return repository ? { ...value, repository } as GitHubPullRequestEvidence : undefined;
}

function checkRunEvidence(
  value: Record<string, unknown>,
): GitHubCheckRunEvidence | undefined {
  if (
    !keys(value, ["checkRunId", "completedAt", "conclusion", "headSha", "kind", "name", "observedAt", "repository", "startedAt", "status"]) ||
    !decimalId(value.checkRunId) ||
    !safeText(value.name, 100) ||
    !sha(value.headSha) ||
    !member(GITHUB_CHECK_STATUSES, value.status) ||
    !(value.conclusion === null || member(GITHUB_CHECK_CONCLUSIONS, value.conclusion)) ||
    !nullableTimestamp(value.startedAt) ||
    !nullableTimestamp(value.completedAt) ||
    !timestamp(value.observedAt) ||
    (value.status === "in_progress" && (value.startedAt === null || value.completedAt !== null)) ||
    (value.status === "completed" &&
      (value.conclusion === null || value.startedAt === null || value.completedAt === null)) ||
    (value.status !== "completed" &&
      (value.conclusion !== null || value.completedAt !== null)) ||
    (value.startedAt !== null && !atOrBefore(value.startedAt, value.observedAt)) ||
    (value.completedAt !== null &&
      (value.startedAt === null || !atOrBefore(value.startedAt, value.completedAt) ||
        !atOrBefore(value.completedAt, value.observedAt)))
  ) return undefined;
  const repository = parseGitHubRepositoryInstallation(value.repository);
  return repository ? { ...value, repository } as GitHubCheckRunEvidence : undefined;
}

function deploymentEvidence(
  value: Record<string, unknown>,
): GitHubDeploymentEvidence | undefined {
  if (
    !keys(value, ["commitSha", "deploymentCreatedAt", "deploymentId", "deploymentStatusId", "environment", "kind", "observedAt", "repository", "state", "statusCreatedAt"]) ||
    !decimalId(value.deploymentId) ||
    !decimalId(value.deploymentStatusId) ||
    !safeText(value.environment, 255) ||
    !sha(value.commitSha) ||
    !member(GITHUB_DEPLOYMENT_STATES, value.state) ||
    !timestamp(value.deploymentCreatedAt) ||
    !timestamp(value.statusCreatedAt) ||
    !timestamp(value.observedAt) ||
    !atOrBefore(value.deploymentCreatedAt, value.statusCreatedAt) ||
    !atOrBefore(value.statusCreatedAt, value.observedAt)
  ) return undefined;
  const repository = parseGitHubRepositoryInstallation(value.repository);
  return repository ? { ...value, repository } as GitHubDeploymentEvidence : undefined;
}

function lineageSubject(input: unknown): GitHubLineageSubject | undefined {
  const value = record(input);
  const kind = value && ownData(value, "kind");
  if (!value || typeof kind !== "string") return undefined;
  if (kind === "nexus_work_item" && keys(value, ["id", "kind"]) &&
      typeof value.id === "string" && WORK_ITEM_ID.test(value.id)) {
    return { kind, id: value.id };
  }
  if ((kind === "github_issue" || kind === "github_pull_request") &&
      keys(value, ["kind", "number"]) && positiveNumber(value.number)) {
    return { kind, number: value.number };
  }
  if (kind === "git_commit" && keys(value, ["kind", "sha"]) && sha(value.sha)) {
    return { kind, sha: value.sha };
  }
  if ((kind === "github_check_run" || kind === "github_deployment") &&
      keys(value, ["id", "kind"]) && decimalId(value.id)) {
    return { kind, id: value.id };
  }
  return undefined;
}

function effectTarget(input: unknown): GitHubEffectTarget | undefined {
  const value = record(input);
  if (!value) return undefined;
  const kind = ownData(value, "kind");
  if (kind === "repository" && keys(value, ["kind"])) return { kind };
  if ((kind === "issue" || kind === "pull_request") &&
      keys(value, ["kind", "number"]) && positiveNumber(value.number)) {
    return { kind, number: value.number };
  }
  return undefined;
}

function validLineage(
  relation: GitHubLineageEdge["relation"],
  source: GitHubLineageSubject,
  target: GitHubLineageSubject,
): boolean {
  if (
    source.kind === "github_issue" &&
    target.kind === "github_pull_request" &&
    source.number === target.number
  ) return false;
  const shape = `${source.kind}:${relation}:${target.kind}`;
  return [
    "nexus_work_item:tracked_by:github_issue",
    "github_issue:implemented_by:github_pull_request",
    "github_pull_request:head_commit:git_commit",
    "github_check_run:verifies:git_commit",
    "github_deployment:deploys:git_commit",
  ].includes(shape);
}

function validEffectTarget(
  action: GitHubEffectIntentDescriptor["actionType"],
  target: GitHubEffectTarget["kind"],
): boolean {
  return {
    "github.issue.create": "repository",
    "github.issue.update": "issue",
    "github.pull_request.create": "repository",
    "github.pull_request.request_review": "pull_request",
    "github.pull_request.merge": "pull_request",
    "github.deployment.promote": "repository",
  }[action] === target;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length &&
    actual.every((key) => {
      if (typeof key !== "string" || !expected.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    });
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function asciiLower(value: unknown): string | undefined {
  return typeof value === "string" &&
    Array.from(value).every((character) => (character.codePointAt(0) ?? 128) < 128)
    ? value.toLowerCase()
    : undefined;
}

function member<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function decimalId(value: unknown): value is string {
  return typeof value === "string" &&
    DECIMAL_ID.test(value) &&
    (value.length < MAX_GITHUB_ID.length ||
      (value.length === MAX_GITHUB_ID.length && value <= MAX_GITHUB_ID));
}

function positiveNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_GITHUB_NUMBER;
}

function sha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value);
}

function timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf()) && instant.toISOString() === value;
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestamp(value);
}

function atOrBefore(left: string, right: string): boolean {
  return left <= right;
}

function safeText(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value === value.normalize("NFC") &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 &&
        !(code >= 127 && code <= 159) &&
        code !== 0x200b &&
        code !== 0x2028 &&
        code !== 0x2029 &&
        !(code >= 0x202a && code <= 0x202e) &&
        code !== 0x2060 &&
        !(code >= 0x2066 && code <= 0x2069) &&
        code !== 0xfeff &&
        !(code >= 0xd800 && code <= 0xdfff);
    }) &&
    Array.from(value).length <= maxCharacters;
}
