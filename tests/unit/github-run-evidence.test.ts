import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_RUN_EVIDENCE_MAX_ITEMS,
  GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION,
  GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION,
} from "../../src/contracts/github-run-evidence";
import {
  GITHUB_WORK_OBSERVATION_SPEC_VERSION,
} from "../../src/contracts/github-work-projection";
import {
  projectGitHubRunEvidence,
} from "../../src/domain/github/github-run-evidence";

const repository = {
  installationId: "12345678",
  repositoryId: "987654321",
  owner: "nexus-os",
  name: "control-plane",
};
const headA = "a".repeat(40);
const headB = "b".repeat(40);
const merge = "c".repeat(40);
const t0 = "2026-07-28T10:00:00.000Z";
const t1 = "2026-07-28T11:00:00.000Z";
const t2 = "2026-07-28T12:00:00.000Z";
const t3 = "2026-07-28T13:00:00.000Z";

function pull(
  number: number,
  headSha = headA,
  state: "open" | "closed" | "merged" = "open",
) {
  return {
    kind: "pull_request" as const,
    repository: { ...repository },
    pullRequestId: String(20_000 + number),
    number,
    state,
    draft: state === "open",
    headSha,
    mergeSha: state === "merged" ? merge : null,
    updatedAt: t2,
    observedAt: t2,
  };
}

function work(evidence: unknown[] = []) {
  return {
    specVersion: GITHUB_WORK_OBSERVATION_SPEC_VERSION,
    repository: { ...repository },
    evidence,
    lineage: [],
  };
}

function observation(
  runEvidence: unknown[] = [],
  workInput: unknown = work(),
) {
  return {
    specVersion: GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION,
    work: workInput,
    runEvidence,
  };
}

function checkRun(
  checkRunId: string,
  headSha = headA,
  status: "queued" | "in_progress" | "completed" = "completed",
) {
  const startedAt = status === "queued" ? null : t0;
  return {
    kind: "check_run" as const,
    repository: { ...repository },
    checkRunId,
    name: `build ${checkRunId}`,
    headSha,
    status,
    conclusion: status === "completed" ? "success" as const : null,
    startedAt,
    completedAt: status === "completed" ? t1 : null,
    observedAt: t2,
  };
}

function deployment(
  deploymentId: string,
  deploymentStatusId: string,
  commitSha = headA,
  state:
    | "error"
    | "failure"
    | "inactive"
    | "in_progress"
    | "queued"
    | "pending"
    | "success" = "success",
) {
  return {
    kind: "deployment" as const,
    repository: { ...repository },
    deploymentId,
    deploymentStatusId,
    environment: "production",
    commitSha,
    state,
    deploymentCreatedAt: t0,
    statusCreatedAt: t1,
    observedAt: t3,
  };
}

test("run-evidence vocabulary and observed-only claim are exact", () => {
  assert.equal(
    GITHUB_RUN_EVIDENCE_OBSERVATION_SPEC_VERSION,
    "nexusos.github-run-evidence-observation.v1",
  );
  assert.equal(
    GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION,
    "nexusos.github-run-evidence-projection.v1",
  );
  assert.equal(GITHUB_RUN_EVIDENCE_MAX_ITEMS, 500);
  const projection = projectGitHubRunEvidence(
    observation([], work([pull(1)])),
  );
  assert.equal(projection?.evidenceClaim, "observed_only_no_authority");
  assert.deepEqual(projection?.commits[0]?.checkRuns, []);
  assert.deepEqual(projection?.commits[0]?.deploymentStatuses, []);
});

test("check runs and every deployment status remain verbatim head evidence", () => {
  const evidence = [
    checkRun("11", headA, "queued"),
    checkRun("2", headA, "in_progress"),
    checkRun("10", headA, "completed"),
    ...[
      "error",
      "failure",
      "inactive",
      "in_progress",
      "queued",
      "pending",
      "success",
    ].map((state, index) =>
      deployment(
        "90",
        String(index + 1),
        headA,
        state as ReturnType<typeof deployment>["state"],
      )
    ),
  ];
  const projection = projectGitHubRunEvidence(
    observation(evidence, work([pull(19, headA)])),
  );
  assert.ok(projection);
  assert.equal(projection.latestRunObservedAt, t3);
  assert.deepEqual(
    projection.commits[0].checkRuns.map((item) => [
      item.checkRunId,
      item.providerStatus,
      item.providerConclusion,
    ]),
    [
      ["2", "in_progress", null],
      ["10", "completed", "success"],
      ["11", "queued", null],
    ],
  );
  assert.deepEqual(
    projection.commits[0].deploymentStatuses.map((item) =>
      item.providerState
    ),
    [
      "error",
      "failure",
      "inactive",
      "in_progress",
      "queued",
      "pending",
      "success",
    ],
  );
  const outputKeys = JSON.stringify(projection);
  for (const forbidden of [
    "workItemStatus",
    "deliverySuccess",
    "approved",
    "mergeEligible",
    "promotion",
  ]) assert.doesNotMatch(outputKeys, new RegExp(forbidden, "u"));
});

test("permutation is canonical and shared heads produce one commit", () => {
  const pulls = [pull(21, headB), pull(18, headA), pull(17, headA)];
  const evidence = [
    deployment("20", "101", headB),
    checkRun("100", headA),
    deployment("10", "5", headA),
    deployment("9", "7", headA),
    deployment("9", "2", headA),
  ];
  const first = projectGitHubRunEvidence(
    observation(evidence, work(pulls)),
  );
  const second = projectGitHubRunEvidence(
    observation([...evidence].reverse(), work([...pulls].reverse())),
  );
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.commits.map((commit) => commit.headSha),
    [headA, headB],
  );
  assert.deepEqual(
    first.commits[0].pullRequests.map((item) => item.number),
    [17, 18],
  );
  assert.deepEqual(
    first.commits[0].deploymentStatuses.map((item) => [
      item.deploymentId,
      item.deploymentStatusId,
    ]),
    [["9", "2"], ["9", "7"], ["10", "5"]],
  );
});

test("merge SHAs and orphan SHAs never act as join keys", () => {
  const merged = pull(17, headA, "merged");
  assert.ok(
    projectGitHubRunEvidence(
      observation([deployment("1", "2", headA)], work([merged])),
    ),
  );
  assert.equal(
    projectGitHubRunEvidence(
      observation([deployment("1", "2", merge)], work([merged])),
    ),
    undefined,
  );
  assert.equal(
    projectGitHubRunEvidence(
      observation([checkRun("1", headB)], work([merged])),
    ),
    undefined,
  );
  assert.equal(
    JSON.stringify(
      projectGitHubRunEvidence(observation([], work([merged]))),
    ).includes(merge),
    false,
  );
});

test("duplicates and contradictory deployment identity fail the whole input", () => {
  const validRepeatedDeployment = [
    deployment("7", "1"),
    deployment("7", "2", headA, "pending"),
  ];
  assert.ok(
    projectGitHubRunEvidence(
      observation(validRepeatedDeployment, work([pull(1)])),
    ),
  );
  for (const invalid of [
    [checkRun("1"), checkRun("1")],
    [deployment("7", "1"), deployment("8", "1")],
    [
      deployment("7", "1"),
      { ...deployment("7", "2"), environment: "staging" },
    ],
    [
      deployment("7", "1"),
      { ...deployment("7", "2"), commitSha: headB },
    ],
    [
      deployment("7", "1"),
      { ...deployment("7", "2"), deploymentCreatedAt: t1 },
    ],
  ]) {
    assert.equal(
      projectGitHubRunEvidence(observation(invalid, work([
        pull(1, headA),
        pull(2, headB),
      ]))),
      undefined,
    );
  }
});

test("malformed, out-of-kind and cross-repository items are never salvaged", () => {
  const issue = {
    kind: "issue",
    repository,
    issueId: "1",
    number: 1,
    state: "open",
    updatedAt: t2,
    closedAt: null,
    observedAt: t2,
  };
  const crossRepository = [
    { installationId: "99999999" },
    { repositoryId: "123" },
    { owner: "other-owner" },
    { name: "other-repository" },
  ].map((changed) => ({
    ...deployment("3", "4"),
    repository: { ...repository, ...changed },
  }));
  for (const invalid of [
    issue,
    { ...checkRun("2"), extra: true },
    ...crossRepository,
    { ...checkRun("2"), headSha: headA.toUpperCase() },
  ]) {
    assert.equal(
      projectGitHubRunEvidence(
        observation([checkRun("1"), invalid], work([pull(1)])),
      ),
      undefined,
    );
  }
});

test("the B6 observation remains untrusted and is reprojected fail-closed", () => {
  for (const invalidWork of [
    { ...work([pull(1)]), extra: true },
    {
      ...work([pull(1)]),
      repository: { ...repository, installationId: "0" },
    },
    {
      ...work([pull(1)]),
      evidence: [pull(1), pull(1)],
    },
    {
      ...work([pull(1)]),
      lineage: [{
        repository,
        source: { kind: "github_issue", number: 9 },
        relation: "implemented_by",
        target: { kind: "github_pull_request", number: 1 },
        recordedAt: t3,
      }],
    },
  ]) {
    assert.equal(
      projectGitHubRunEvidence(observation([], invalidWork)),
      undefined,
    );
  }
});

test("envelope and run array reject hidden, symbolic, inherited and accessor state", () => {
  const valid = observation([], work([pull(1)]));
  const symbolic = { ...valid, [Symbol("hidden")]: true };
  const inherited = Object.assign(Object.create({ inherited: true }), valid);
  const hidden = { ...valid };
  Object.defineProperty(hidden, "extra", {
    enumerable: false,
    value: true,
  });
  const protoKey = { ...valid };
  Object.defineProperty(protoKey, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  for (const invalid of [
    symbolic,
    inherited,
    hidden,
    protoKey,
    { ...valid, specVersion: "nexusos.github-run-evidence-observation.v2" },
  ]) {
    assert.equal(projectGitHubRunEvidence(invalid), undefined);
  }
  let getterRead = false;
  const accessor = { ...valid };
  Object.defineProperty(accessor, "runEvidence", {
    enumerable: true,
    get() {
      getterRead = true;
      return [];
    },
  });
  assert.equal(projectGitHubRunEvidence(accessor), undefined);
  assert.equal(getterRead, false);

  const sparse = observation();
  sparse.runEvidence = Array(1);
  const decorated = observation([checkRun("1")]);
  Object.assign(decorated.runEvidence, { extra: true });
  class Exotic<T> extends Array<T> {}
  const exotic = observation();
  exotic.runEvidence = new Exotic();
  for (const invalid of [sparse, decorated, exotic]) {
    assert.equal(projectGitHubRunEvidence(invalid), undefined);
  }
  assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
});

test("throwing and shifting proxies are total stable failures", () => {
  const throwing = new Proxy(observation(), {
    ownKeys() {
      throw new Error("hostile reflection");
    },
  });
  assert.equal(projectGitHubRunEvidence(throwing), undefined);

  let reads = 0;
  const shifting = new Proxy(checkRun("1"), {
    get(target, key, receiver) {
      if (key === "checkRunId") {
        reads += 1;
        return reads === 1 ? target.checkRunId : { malformed: true };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(
    projectGitHubRunEvidence(
      observation([shifting], work([pull(1)])),
    ),
    undefined,
  );
});

test("the 500-item boundary is inclusive and checked before salvage", () => {
  const maximum = Array.from(
    { length: GITHUB_RUN_EVIDENCE_MAX_ITEMS },
    (_, index) => checkRun(String(index + 1)),
  );
  const accepted = projectGitHubRunEvidence(
    observation(maximum, work([pull(1)])),
  );
  assert.equal(accepted?.commits[0].checkRuns.length, 500);
  assert.equal(
    projectGitHubRunEvidence(
      observation([...maximum, checkRun("501")], work([pull(1)])),
    ),
    undefined,
  );
});

test("output is deeply frozen, defensively copied and has run-only freshness", () => {
  const mutableCheck = checkRun("1");
  const mutableWork = work([
    { ...pull(1), observedAt: t3, updatedAt: t3 },
  ]);
  const input = observation([mutableCheck], mutableWork);
  const projection = projectGitHubRunEvidence(input);
  assert.ok(projection);
  assert.equal(projection.latestRunObservedAt, t2);
  assertDeepFrozen(projection);
  assert.notEqual(projection.repository, mutableWork.repository);
  mutableCheck.name = "mutated";
  mutableWork.repository.owner = "mutated-owner";
  assert.equal(projection.commits[0].checkRuns[0].name, "build 1");
  assert.deepEqual(projection.repository, repository);
});

test("an entirely empty observation is truthful", () => {
  assert.deepEqual(projectGitHubRunEvidence(observation()), {
    specVersion: GITHUB_RUN_EVIDENCE_PROJECTION_SPEC_VERSION,
    repository,
    latestRunObservedAt: null,
    evidenceClaim: "observed_only_no_authority",
    commits: [],
  });
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
