import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_WORK_MAX_EVIDENCE,
  GITHUB_WORK_MAX_LINEAGE_EDGES,
  GITHUB_WORK_OBSERVATION_SPEC_VERSION,
  GITHUB_WORK_PROJECTION_SPEC_VERSION,
} from "../../src/contracts/github-work-projection";
import {
  githubWorkNodeRef,
  projectGitHubWork,
} from "../../src/domain/github/github-work-projection";

const repository = {
  installationId: "12345678",
  repositoryId: "987654321",
  owner: "nexus-os",
  name: "control-plane",
};
const observedAt = "2026-07-28T12:00:00.000Z";
const recordedAt = "2026-07-28T12:00:01.000Z";

function issue(
  number: number,
  state: "open" | "closed" = "open",
  issueId = String(10_000 + number),
) {
  return {
    kind: "issue" as const,
    repository: { ...repository },
    issueId,
    number,
    state,
    updatedAt: observedAt,
    closedAt: state === "closed" ? observedAt : null,
    observedAt,
  };
}

function pull(
  number: number,
  state: "open" | "closed" | "merged" = "open",
  pullRequestId = String(20_000 + number),
) {
  return {
    kind: "pull_request" as const,
    repository: { ...repository },
    pullRequestId,
    number,
    state,
    draft: state === "open",
    headSha: number.toString(16).padStart(40, "a").slice(-40),
    mergeSha: state === "merged" ? "b".repeat(40) : null,
    updatedAt: observedAt,
    observedAt,
  };
}

function trackedBy(workItemId: string, issueNumber: number) {
  return {
    repository: { ...repository },
    source: { kind: "nexus_work_item" as const, id: workItemId },
    relation: "tracked_by" as const,
    target: { kind: "github_issue" as const, number: issueNumber },
    recordedAt,
  };
}

function implementedBy(issueNumber: number, pullNumber: number) {
  return {
    repository: { ...repository },
    source: { kind: "github_issue" as const, number: issueNumber },
    relation: "implemented_by" as const,
    target: { kind: "github_pull_request" as const, number: pullNumber },
    recordedAt,
  };
}

function observation(
  evidence: unknown[] = [],
  lineage: unknown[] = [],
): Record<string, unknown> {
  return {
    specVersion: GITHUB_WORK_OBSERVATION_SPEC_VERSION,
    repository: { ...repository },
    evidence,
    lineage,
  };
}

test("projection vocabulary and artifact refs are stable and installation-neutral", () => {
  assert.equal(
    GITHUB_WORK_OBSERVATION_SPEC_VERSION,
    "nexusos.github-work-observation.v1",
  );
  assert.equal(
    GITHUB_WORK_PROJECTION_SPEC_VERSION,
    "nexusos.github-work-projection.v1",
  );
  assert.equal(GITHUB_WORK_MAX_EVIDENCE, 500);
  assert.equal(GITHUB_WORK_MAX_LINEAGE_EDGES, 500);
  assert.equal(
    githubWorkNodeRef(repository, "issue", 42),
    "github:repository:987654321:issue:42",
  );
  assert.equal(
    githubWorkNodeRef(
      { ...repository, installationId: "87654321" },
      "issue",
      42,
    ),
    "github:repository:987654321:issue:42",
  );
  for (const [kind, number] of [
    ["discussion", 1],
    ["issue", 0],
    ["pull_request", 2_147_483_648],
  ] as const) {
    assert.equal(githubWorkNodeRef(repository, kind as never, number), undefined);
  }
  assert.equal(
    githubWorkNodeRef({ ...repository, repositoryId: "0" }, "issue", 1),
    undefined,
  );
});

test("open issues are title-less proposals while pull requests stay evidence-only", () => {
  const projection = projectGitHubWork(
    observation(
      [pull(17), issue(42)],
      [implementedBy(42, 17)],
    ),
  );
  assert.ok(projection);
  assert.deepEqual(projection.repository, repository);
  assert.equal(projection.latestObservedAt, observedAt);
  assert.equal(projection.lineageClaim, "caller_asserted_unverified");
  assert.deepEqual(
    projection.nodes.map(({ kind, number, disposition }) => ({
      kind,
      number,
      disposition,
    })),
    [
      { kind: "github_issue", number: 42, disposition: "proposed" },
      {
        kind: "github_pull_request",
        number: 17,
        disposition: "evidence_only",
      },
    ],
  );
  assert.deepEqual(projection.proposals, [{
    claim: "proposal_only_no_import",
    issueRef: "github:repository:987654321:issue:42",
    issueId: "10042",
    issueNumber: 42,
    suggestedExternalRef: "github:repository:987654321:issue:42",
    suggestedKind: "task",
    suggestedStatus: "backlog",
  }]);
  assert.equal("title" in projection.proposals[0], false);
  assert.equal("description" in projection.proposals[0], false);
  assert.deepEqual(projection.links, [{
    relation: "implemented_by",
    sourceRef: "github:repository:987654321:issue:42",
    sourceIssueNumber: 42,
    targetRef: "github:repository:987654321:pull_request:17",
    targetPullRequestNumber: 17,
    recordedAt,
  }]);
});

test("tracked and closed issues never become import proposals", () => {
  const projection = projectGitHubWork(
    observation(
      [issue(9, "closed"), issue(8)],
      [trackedBy("work:closed-9", 9), trackedBy("work:open-8", 8)],
    ),
  );
  assert.ok(projection);
  assert.deepEqual(projection.proposals, []);
  const open = projection.nodes.find((node) => node.number === 8);
  const closed = projection.nodes.find((node) => node.number === 9);
  assert.deepEqual(
    open && {
      disposition: open.disposition,
      trackedWorkItemId: "trackedWorkItemId" in open
        ? open.trackedWorkItemId
        : undefined,
    },
    { disposition: "tracked", trackedWorkItemId: "work:open-8" },
  );
  assert.deepEqual(
    closed && {
      disposition: closed.disposition,
      trackedWorkItemId: "trackedWorkItemId" in closed
        ? closed.trackedWorkItemId
        : undefined,
    },
    { disposition: "observed_only", trackedWorkItemId: "work:closed-9" },
  );
  assert.equal(projection.links.length, 2);
});

test("every pull request state remains external evidence and preserves B7 join keys", () => {
  const projection = projectGitHubWork(observation([
    pull(3, "merged"),
    pull(2, "closed"),
    pull(1, "open"),
  ]));
  assert.ok(projection);
  assert.deepEqual(projection.proposals, []);
  for (const node of projection.nodes) {
    assert.equal(node.kind, "github_pull_request");
    assert.equal(node.disposition, "evidence_only");
    assert.match(node.headSha, /^[0-9a-f]{40}$/u);
  }
  const merged = projection.nodes.find((node) => node.number === 3);
  assert.equal(
    merged?.kind === "github_pull_request" ? merged.mergeSha : undefined,
    "b".repeat(40),
  );
});

test("the empty observation is truthful and carries no invented freshness", () => {
  assert.deepEqual(projectGitHubWork(observation()), {
    specVersion: GITHUB_WORK_PROJECTION_SPEC_VERSION,
    repository,
    latestObservedAt: null,
    lineageClaim: "caller_asserted_unverified",
    nodes: [],
    links: [],
    proposals: [],
  });
});

test("one malformed or out-of-scope element rejects the complete observation", () => {
  const checkRun = {
    kind: "check_run",
    repository,
    checkRunId: "111",
    name: "build",
    headSha: "a".repeat(40),
    status: "queued",
    conclusion: null,
    startedAt: null,
    completedAt: null,
    observedAt,
  };
  const deployment = {
    kind: "deployment",
    repository,
    deploymentId: "222",
    deploymentStatusId: "333",
    environment: "production",
    commitSha: "a".repeat(40),
    state: "success",
    deploymentCreatedAt: observedAt,
    statusCreatedAt: observedAt,
    observedAt,
  };
  for (const invalid of [
    { ...issue(2), body: "not in the frozen observation" },
    checkRun,
    deployment,
  ]) {
    assert.equal(
      projectGitHubWork(observation([issue(1), invalid])),
      undefined,
    );
  }
  const headCommit = {
    repository,
    source: { kind: "github_pull_request", number: 2 },
    relation: "head_commit",
    target: { kind: "git_commit", sha: "a".repeat(40) },
    recordedAt,
  };
  assert.equal(
    projectGitHubWork(observation([pull(2)], [headCommit])),
    undefined,
  );
});

test("repository identity is exact across the envelope, evidence and lineage", () => {
  for (const changed of [
    { installationId: "99999999" },
    { repositoryId: "123123123" },
    { owner: "other-owner" },
    { name: "other-repository" },
  ]) {
    assert.equal(
      projectGitHubWork(
        observation([{ ...issue(1), repository: { ...repository, ...changed } }]),
      ),
      undefined,
    );
    assert.equal(
      projectGitHubWork(
        observation(
          [issue(1)],
          [{
            ...trackedBy("work:1", 1),
            repository: { ...repository, ...changed },
          }],
        ),
      ),
      undefined,
    );
  }
});

test("number shadows and within-kind provider ID collisions fail closed", () => {
  for (const evidence of [
    [issue(1), issue(1, "open", "999")],
    [pull(1), pull(1, "closed", "999")],
    [issue(1), pull(1)],
    [issue(1, "open", "777"), issue(2, "open", "777")],
    [pull(1, "open", "888"), pull(2, "closed", "888")],
  ]) {
    assert.equal(projectGitHubWork(observation(evidence)), undefined);
  }
  assert.ok(projectGitHubWork(observation([
    issue(1, "open", "999"),
    pull(2, "open", "999"),
  ])));
});

test("tracking is injective in both directions and repeated triples are invalid", () => {
  for (const lineage of [
    [trackedBy("work:1", 1), trackedBy("work:2", 1)],
    [trackedBy("work:1", 1), trackedBy("work:1", 2)],
    [
      trackedBy("work:1", 1),
      { ...trackedBy("work:1", 1), recordedAt: observedAt },
    ],
  ]) {
    assert.equal(
      projectGitHubWork(observation([issue(1), issue(2)], lineage)),
      undefined,
    );
  }
  assert.equal(
    projectGitHubWork(observation(
      [issue(1), pull(2)],
      [
        implementedBy(1, 2),
        { ...implementedBy(1, 2), recordedAt: observedAt },
      ],
    )),
    undefined,
  );
});

test("GitHub lineage endpoints must exist in accepted evidence", () => {
  assert.equal(
    projectGitHubWork(observation([], [trackedBy("work:1", 1)])),
    undefined,
  );
  assert.equal(
    projectGitHubWork(observation([issue(1)], [implementedBy(1, 2)])),
    undefined,
  );
  assert.equal(
    projectGitHubWork(observation([pull(2)], [implementedBy(1, 2)])),
    undefined,
  );
});

test("envelopes fail closed for extra, hidden, symbolic, inherited and accessor keys", () => {
  const extra = { ...observation(), extra: true };
  const symbolic = { ...observation(), [Symbol("hidden")]: true };
  const inherited = Object.assign(
    Object.create({ inherited: true }),
    observation(),
  );
  const hidden = observation();
  Object.defineProperty(hidden, "extra", {
    enumerable: false,
    value: true,
  });
  const protoKey = observation();
  Object.defineProperty(protoKey, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  for (const invalid of [extra, symbolic, inherited, hidden, protoKey]) {
    assert.equal(projectGitHubWork(invalid), undefined);
  }
  for (const invalid of [
    null,
    [],
    "observation",
    {},
    { ...observation(), specVersion: "nexusos.github-work-observation.v2" },
  ]) {
    assert.equal(projectGitHubWork(invalid), undefined);
  }
  let getterRead = false;
  const accessor = observation();
  Object.defineProperty(accessor, "evidence", {
    enumerable: true,
    get() {
      getterRead = true;
      return [];
    },
  });
  assert.equal(projectGitHubWork(accessor), undefined);
  assert.equal(getterRead, false);
  assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
});

test("throwing reflection and exotic arrays are total failures", () => {
  const throwing = new Proxy(observation(), {
    ownKeys() {
      throw new Error("hostile reflection");
    },
  });
  assert.equal(projectGitHubWork(throwing), undefined);
  const sparse = observation();
  sparse.evidence = Array(1);
  const decorated = observation([issue(1)]);
  Object.assign(decorated.evidence as unknown[], { extra: true });
  class Exotic<T> extends Array<T> {}
  const exotic = observation();
  exotic.lineage = new Exotic();
  for (const invalid of [sparse, decorated, exotic]) {
    assert.equal(projectGitHubWork(invalid), undefined);
  }
});

test("shifting proxies cannot escape the stable B1 snapshot boundary", () => {
  let repositoryReads = 0;
  const shiftingRepository = new Proxy({ ...repository }, {
    get(target, key, receiver) {
      if (key === "installationId") {
        repositoryReads += 1;
        return repositoryReads === 1
          ? target.installationId
          : { malformed: true };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(
    projectGitHubWork({
      ...observation(),
      repository: shiftingRepository,
    }),
    undefined,
  );
  repositoryReads = 0;
  assert.equal(
    githubWorkNodeRef(shiftingRepository, "issue", 1),
    undefined,
  );

  let evidenceReads = 0;
  const shiftingEvidence = new Proxy(issue(1), {
    get(target, key, receiver) {
      if (key === "issueId") {
        evidenceReads += 1;
        return evidenceReads === 1
          ? target.issueId
          : { malformed: true };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(
    projectGitHubWork(observation([shiftingEvidence])),
    undefined,
  );

  let lineageReads = 0;
  const shiftingLineage = new Proxy(trackedBy("work:1", 1), {
    get(target, key, receiver) {
      if (key === "recordedAt") {
        lineageReads += 1;
        return lineageReads === 1
          ? target.recordedAt
          : { malformed: true };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(
    projectGitHubWork(observation([issue(1)], [shiftingLineage])),
    undefined,
  );
});

test("evidence and lineage bounds are inclusive and enforced before salvage", () => {
  const fiveHundredIssues = Array.from(
    { length: GITHUB_WORK_MAX_EVIDENCE },
    (_, index) => issue(index + 1, "open", String(100_000 + index)),
  );
  const maximum = projectGitHubWork(observation(fiveHundredIssues));
  assert.ok(maximum);
  assert.equal(maximum.nodes.length, 500);
  assert.equal(maximum.proposals.length, 500);
  assert.equal(
    projectGitHubWork(observation([...fiveHundredIssues, issue(501)])),
    undefined,
  );

  const issues = [issue(1), issue(2)];
  const pulls = Array.from(
    { length: 498 },
    (_, index) => pull(index + 3, "open", String(200_000 + index)),
  );
  const fiveHundredEdges = [
    ...pulls.map((item) => implementedBy(1, item.number)),
    implementedBy(2, 3),
    implementedBy(2, 4),
  ];
  const edgeMaximum = projectGitHubWork(
    observation([...issues, ...pulls], fiveHundredEdges),
  );
  assert.ok(edgeMaximum);
  assert.equal(edgeMaximum.links.length, 500);
  assert.equal(
    projectGitHubWork(
      observation(
        [...issues, ...pulls],
        [...fiveHundredEdges, implementedBy(2, 5)],
      ),
    ),
    undefined,
  );
});

test("projection is code-unit canonical, deeply frozen and owns every output value", () => {
  const input = observation(
    [pull(17), issue(42), issue(7, "closed")],
    [implementedBy(42, 17), trackedBy("work:7", 7)],
  );
  const first = projectGitHubWork(input);
  const second = projectGitHubWork(
    observation(
      [...(input.evidence as unknown[])].reverse(),
      [...(input.lineage as unknown[])].reverse(),
    ),
  );
  assert.ok(first);
  assert.deepEqual(first, second);
  assertDeepFrozen(first);
  assert.notEqual(first.repository, input.repository);
  const mutableIssue = (input.evidence as Array<Record<string, unknown>>)[1];
  mutableIssue.issueId = "999999";
  (input.repository as Record<string, unknown>).owner = "mutated-owner";
  assert.equal(
    first.nodes.find((node) => node.number === 42)?.ref,
    "github:repository:987654321:issue:42",
  );
  assert.deepEqual(first.repository, repository);
});

test("freshness is the evidence maximum and never uses lineage time", () => {
  const earlier = "2026-07-28T10:00:00.000Z";
  const later = "2026-07-28T11:00:00.000Z";
  const lateLineage = "2026-07-29T12:00:00.000Z";
  const projection = projectGitHubWork(
    observation(
      [
        { ...issue(1), updatedAt: earlier, observedAt: earlier },
        { ...issue(2), updatedAt: later, observedAt: later },
      ],
      [{ ...trackedBy("work:1", 1), recordedAt: lateLineage }],
    ),
  );
  assert.equal(projection?.latestObservedAt, later);
});

function assertDeepFrozen(input: unknown): void {
  if (!input || typeof input !== "object") return;
  assert.equal(Object.isFrozen(input), true);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor && "value" in descriptor) {
      assertDeepFrozen(descriptor.value);
    }
  }
}
