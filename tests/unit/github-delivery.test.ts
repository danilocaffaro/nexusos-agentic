import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GITHUB_CHECK_CONCLUSIONS,
  GITHUB_CHECK_STATUSES,
  GITHUB_DEPLOYMENT_STATES,
  GITHUB_EFFECT_ACTION_TYPES,
  GITHUB_LINEAGE_RELATIONS,
} from "../../src/contracts/github-delivery";
import {
  githubEffectTargetRef,
  parseGitHubDeliveryEvidence,
  parseGitHubEffectIntentDescriptor,
  parseGitHubLineageEdge,
  parseGitHubRepositoryInstallation,
} from "../../src/domain/github/github-delivery";

const repository = {
  installationId: "12345678",
  repositoryId: "987654321",
  owner: "nexus-os",
  name: "control_plane.git",
};
const observedAt = "2026-07-27T12:00:00.000Z";
const sha = "a".repeat(40);

test("GitHub delivery vocabularies are closed and GitHub Free compatible", () => {
  assert.deepEqual(GITHUB_CHECK_STATUSES, ["queued", "in_progress", "completed"]);
  assert.deepEqual(GITHUB_CHECK_CONCLUSIONS, [
    "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
    "startup_failure", "success", "timed_out",
  ]);
  assert.deepEqual(GITHUB_DEPLOYMENT_STATES, [
    "error", "failure", "inactive", "in_progress", "queued", "pending", "success",
  ]);
  assert.deepEqual(GITHUB_LINEAGE_RELATIONS, [
    "tracked_by", "implemented_by", "head_commit", "verifies", "deploys",
  ]);
  assert.deepEqual(GITHUB_EFFECT_ACTION_TYPES, [
    "github.issue.create",
    "github.issue.update",
    "github.pull_request.create",
    "github.pull_request.request_review",
    "github.pull_request.merge",
    "github.deployment.promote",
  ]);
});

test("repository installation identity is canonical, exact and copied", () => {
  const parsed = parseGitHubRepositoryInstallation(repository);
  assert.deepEqual(parsed, repository);
  assert.notEqual(parsed, repository);
  assert.deepEqual(
    parseGitHubRepositoryInstallation({
      ...repository,
      installationId: "9223372036854775807",
    })?.installationId,
    "9223372036854775807",
  );
  assert.deepEqual(
    parseGitHubRepositoryInstallation({
      ...repository,
      owner: "Nexus-OS",
      name: "Control_Plane.GIT",
    }),
    repository,
  );
  for (const invalid of [
    { ...repository, installationId: 12345678 },
    { ...repository, installationId: "012345678" },
    { ...repository, repositoryId: "0" },
    { ...repository, repositoryId: "1".repeat(21) },
    { ...repository, repositoryId: "10000000000000000000" },
    { ...repository, repositoryId: "9223372036854775808" },
    { ...repository, owner: "-nexus" },
    { ...repository, owner: "nexus--os" },
    { ...repository, owner: "\u212A" },
    { ...repository, name: ".." },
    { ...repository, extra: true },
    Object.assign(Object.create({ polluted: true }), repository),
  ]) {
    assert.equal(parseGitHubRepositoryInstallation(invalid), undefined);
  }
  const symbol = { ...repository, [Symbol("hidden")]: true };
  assert.equal(parseGitHubRepositoryInstallation(symbol), undefined);
  const accessor = { ...repository };
  let getterRead = false;
  Object.defineProperty(accessor, "owner", {
    enumerable: true,
    get() {
      getterRead = true;
      return repository.owner;
    },
  });
  assert.equal(parseGitHubRepositoryInstallation(accessor), undefined);
  assert.equal(getterRead, false);
  const nonEnumerable = { ...repository };
  Object.defineProperty(nonEnumerable, "name", {
    enumerable: false,
    value: repository.name,
  });
  assert.equal(parseGitHubRepositoryInstallation(nonEnumerable), undefined);
});

test("issue evidence binds state, closure, installation and observation", () => {
  const open = {
    kind: "issue",
    repository,
    issueId: "9000000000000000000",
    number: 42,
    state: "open",
    updatedAt: "2026-07-27T11:59:00.000Z",
    closedAt: null,
    observedAt,
  };
  assert.deepEqual(parseGitHubDeliveryEvidence(open), open);
  const closed = {
    ...open,
    state: "closed",
    closedAt: "2026-07-27T11:58:00.000Z",
  };
  assert.deepEqual(parseGitHubDeliveryEvidence(closed), closed);
  for (const invalid of [
    { ...open, issueId: 1 },
    { ...open, number: 0 },
    { ...open, number: 2_147_483_648 },
    { ...open, state: "reopened" },
    { ...open, closedAt: observedAt },
    { ...closed, closedAt: null },
    { ...open, updatedAt: "2026-07-27T11:59:00Z" },
    { ...open, updatedAt: "2026-07-27T12:00:01.000Z" },
    { ...closed, closedAt: observedAt, updatedAt: "2026-07-27T11:59:00.000Z" },
    { ...open, body: "private issue content" },
  ]) {
    assert.equal(parseGitHubDeliveryEvidence(invalid), undefined);
  }
});

test("pull request evidence rejects ambiguous merge and draft states", () => {
  const open = {
    kind: "pull_request",
    repository,
    pullRequestId: "11223344",
    number: 17,
    state: "open",
    draft: true,
    headSha: sha,
    mergeSha: null,
    updatedAt: observedAt,
    observedAt,
  };
  assert.deepEqual(parseGitHubDeliveryEvidence(open), open);
  const merged = {
    ...open,
    state: "merged",
    draft: false,
    mergeSha: "b".repeat(40),
  };
  assert.deepEqual(parseGitHubDeliveryEvidence(merged), merged);
  for (const invalid of [
    { ...open, headSha: sha.toUpperCase() },
    { ...open, mergeSha: "b".repeat(40) },
    { ...merged, mergeSha: null },
    { ...merged, draft: true },
    { ...open, state: "MERGED" },
    { ...open, updatedAt: "2026-07-27T12:00:00.001Z" },
    { ...open, labels: [] },
  ]) {
    assert.equal(parseGitHubDeliveryEvidence(invalid), undefined);
  }
});

test("check evidence enforces the closed status/conclusion timeline matrix", () => {
  const queued = {
    kind: "check_run",
    repository,
    checkRunId: "12345",
    name: "build / linux",
    headSha: sha,
    status: "queued",
    conclusion: null,
    startedAt: null,
    completedAt: null,
    observedAt,
  };
  const inProgress = { ...queued, status: "in_progress", startedAt: observedAt };
  const queuedStarted = { ...queued, startedAt: observedAt };
  const completed = {
    ...inProgress,
    status: "completed",
    conclusion: "success",
    completedAt: observedAt,
  };
  for (const valid of [queued, queuedStarted, inProgress, completed]) {
    assert.deepEqual(parseGitHubDeliveryEvidence(valid), valid);
  }
  for (const invalid of [
    { ...queued, status: "waiting" },
    { ...queuedStarted, completedAt: observedAt },
    { ...inProgress, conclusion: "success" },
    { ...completed, conclusion: null },
    { ...completed, conclusion: "passed" },
    { ...completed, completedAt: "2026-07-27T12:00:00+00:00" },
    { ...completed, startedAt: null },
    { ...completed, startedAt: observedAt, completedAt: "2026-07-27T11:59:59.999Z" },
    { ...completed, name: " build" },
    { ...completed, name: "e\u0301" },
    { ...completed, name: "unsafe\u0085name" },
    { ...completed, name: "unsafe\u202ename" },
    { ...completed, name: "unsafe\u200bname" },
    { ...completed, name: "\ud800" },
    { ...completed, name: "x".repeat(101) },
  ]) {
    assert.equal(parseGitHubDeliveryEvidence(invalid), undefined);
  }
  assert.deepEqual(
    parseGitHubDeliveryEvidence({ ...completed, name: "🚀".repeat(100) }),
    { ...completed, name: "🚀".repeat(100) },
  );
});

test("deployment evidence carries the exact commit and status observation", () => {
  const deployment = {
    kind: "deployment",
    repository,
    deploymentId: "3333",
    deploymentStatusId: "4444",
    environment: "production",
    commitSha: sha,
    state: "success",
    deploymentCreatedAt: "2026-07-27T11:59:58.000Z",
    statusCreatedAt: "2026-07-27T11:59:59.000Z",
    observedAt,
  };
  assert.deepEqual(parseGitHubDeliveryEvidence(deployment), deployment);
  for (const invalid of [
    { ...deployment, deploymentStatusId: 4444 },
    { ...deployment, environment: "" },
    { ...deployment, environment: "production\nspoof" },
    { ...deployment, state: "succeeded" },
    { ...deployment, commitSha: ` ${sha}` },
    { ...deployment, deploymentCreatedAt: observedAt, statusCreatedAt: "2026-07-27T11:59:59.000Z" },
    { ...deployment, statusCreatedAt: "2026-07-27T12:00:00.001Z" },
    { ...deployment, url: "https://example.invalid/private" },
  ]) {
    assert.equal(parseGitHubDeliveryEvidence(invalid), undefined);
  }
});

test("evidence parser rejects unknown kinds, non-records and malformed repository", () => {
  for (const invalid of [
    null,
    [],
    "issue",
    { kind: "workflow_run" },
    { kind: "issue" },
    {
      kind: "deployment",
      repository: { ...repository, owner: "-Nexus-OS" },
      deploymentId: "1",
      deploymentStatusId: "2",
      environment: "production",
      commitSha: sha,
      state: "success",
      deploymentCreatedAt: observedAt,
      statusCreatedAt: observedAt,
      observedAt,
    },
  ]) {
    assert.equal(parseGitHubDeliveryEvidence(invalid), undefined);
  }
});

test("lineage accepts only the five directed, repository-bound edges", () => {
  const valid = [
    ["nexus_work_item", "tracked_by", "github_issue", { id: "work:NX-42" }, { number: 42 }],
    ["github_issue", "implemented_by", "github_pull_request", { number: 42 }, { number: 17 }],
    ["github_pull_request", "head_commit", "git_commit", { number: 17 }, { sha }],
    ["github_check_run", "verifies", "git_commit", { id: "12345" }, { sha }],
    ["github_deployment", "deploys", "git_commit", { id: "3333" }, { sha }],
  ] as const;
  for (const [sourceKind, relation, targetKind, source, target] of valid) {
    const edge = {
      repository,
      source: { kind: sourceKind, ...source },
      relation,
      target: { kind: targetKind, ...target },
      recordedAt: observedAt,
    };
    assert.deepEqual(parseGitHubLineageEdge(edge), edge);
  }
  for (const invalid of [
    {
      repository,
      source: { kind: "github_issue", number: 42 },
      relation: "tracked_by",
      target: { kind: "nexus_work_item", id: "work:NX-42" },
      recordedAt: observedAt,
    },
    {
      repository,
      source: { kind: "github_check_run", id: "12345" },
      relation: "verifies",
      target: { kind: "git_commit", sha: sha.toUpperCase() },
      recordedAt: observedAt,
    },
    {
      repository,
      source: { kind: "nexus_work_item", id: "work id with spaces" },
      relation: "tracked_by",
      target: { kind: "github_issue", number: 42 },
      recordedAt: observedAt,
    },
    {
      repository,
      source: { kind: "github_issue", number: 17 },
      relation: "implemented_by",
      target: { kind: "github_pull_request", number: 17 },
      recordedAt: observedAt,
    },
  ]) {
    assert.equal(parseGitHubLineageEdge(invalid), undefined);
  }
});

test("effect intent descriptors enforce action/target pairing and stable refs", () => {
  const cases = [
    ["github.issue.create", { kind: "repository" }, "github:installation:12345678:repository:987654321"],
    ["github.issue.update", { kind: "issue", number: 42 }, "github:installation:12345678:repository:987654321:issue:42"],
    ["github.pull_request.create", { kind: "repository" }, "github:installation:12345678:repository:987654321"],
    ["github.pull_request.request_review", { kind: "pull_request", number: 17 }, "github:installation:12345678:repository:987654321:pull_request:17"],
    ["github.pull_request.merge", { kind: "pull_request", number: 17 }, "github:installation:12345678:repository:987654321:pull_request:17"],
    ["github.deployment.promote", { kind: "repository" }, "github:installation:12345678:repository:987654321"],
  ] as const;
  for (const [actionType, target, ref] of cases) {
    const descriptor = { actionType, repository, target };
    assert.deepEqual(parseGitHubEffectIntentDescriptor(descriptor), descriptor);
    assert.equal(githubEffectTargetRef(descriptor), ref);
  }
  for (const invalid of [
    { actionType: "github.issue.create", repository, target: { kind: "issue", number: 1 } },
    { actionType: "github.issue.update", repository, target: { kind: "repository" } },
    { actionType: "github.pull_request.merge", repository, target: { kind: "pull_request", number: 0 } },
    { actionType: "github.check_run.rerequest", repository, target: { kind: "repository" } },
    { actionType: "github.deployment.promote", repository, target: { kind: "deployment", id: "1" } },
  ]) {
    assert.equal(parseGitHubEffectIntentDescriptor(invalid), undefined);
    assert.throws(
      () => githubEffectTargetRef(invalid as never),
      /Invalid GitHub effect intent descriptor/u,
    );
  }
});

test("GitHub delivery contracts stay dark, route-free and effect-free", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const productionModules = [
    join(root, "src/contracts/github-authorization.ts"),
    join(root, "src/contracts/github-delivery.ts"),
    join(root, "src/contracts/github-installation-snapshot.ts"),
    join(root, "src/contracts/github-installation-source.ts"),
    join(root, "src/domain/github/github-authorization.ts"),
    join(root, "src/domain/github/github-delivery.ts"),
    join(root, "src/domain/github/github-installation-snapshot.ts"),
    join(root, "src/domain/github/github-installation-source.ts"),
  ];
  const realDiscoveryModules = [
    join(root, "scripts/live/github-installation-discovery-live.mjs"),
    join(root, "src/adapters/github/github-installation-discovery.ts"),
    join(root, "src/contracts/github-installation-discovery.ts"),
  ];
  for (const file of productionModules) {
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /(?:\bfetch\s*\(|\b(?:Request|WebSocket)\b|node:(?:http|https|net|dns|tls)|child_process|drizzle|oauth|secret|octokit|api\.github\.com|\bbearer\b|installation.?token|private.?key|\bjwt\b|\bapp_id\b)/iu,
      file,
    );
  }
  for (const file of realDiscoveryModules) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /(?:child_process|node:(?:dns|fs|http|https|net|tls)|drizzle|WebSocket|writeFile|appendFile|\b(?:DELETE|PATCH|POST|PUT)\b)/u,
      file,
    );
    const externalUrls = source.match(/https?:\/\/[^\s"'`)]+/gu) ?? [];
    assert.deepEqual(
      [...new Set(externalUrls)],
      file === join(
        root,
        "src/contracts/github-installation-discovery.ts",
      )
        ? ["https://api.github.com"]
        : [],
      file,
    );
  }
  const skipped = new Set([
    ".git", ".next", ".wrangler", "build", "dist", "docs", "node_modules",
    "out", "tests",
  ]);
  for (const file of await files(root, skipped)) {
    if (
      !/\.(?:[cm]?[jt]sx?|sql)$/u.test(file) ||
      productionModules.includes(file) ||
      realDiscoveryModules.includes(file)
    ) continue;
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /github-(?:authorization|delivery|installation-(?:snapshot|source))/u,
      file,
    );
  }
});

async function files(
  directory: string,
  skipped = new Set<string>(),
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !skipped.has(entry.name)) {
      found.push(...await files(path, skipped));
    }
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
