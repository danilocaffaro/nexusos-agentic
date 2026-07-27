import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ADMISSION_FRESHNESS_SECONDS,
  DEFAULT_RUNNER_ADMISSION_POLICY,
  MAX_ADMISSION_FRESHNESS_SECONDS,
  MIN_ADMISSION_FRESHNESS_SECONDS,
  nextPolicyUpdatedAt,
  parseAdmissionPolicyPut,
} from "../../src/domain/runners/admission-policy";

test("admission policy parser is strict, bounded and canonically ordered", () => {
  assert.deepEqual(
    parseAdmissionPolicyPut({
      expectedVersion: 3,
      capabilityFreshnessSeconds: 86_400,
      allowedCapabilities: ["podman", "bubblewrap", "seccomp"],
    }),
    {
      expectedVersion: 3,
      capabilityFreshnessSeconds: 86_400,
      allowedCapabilities: ["bubblewrap", "seccomp", "podman"],
    },
  );
  assert.deepEqual(
    parseAdmissionPolicyPut({
      expectedVersion: 0,
      capabilityFreshnessSeconds: MIN_ADMISSION_FRESHNESS_SECONDS,
      allowedCapabilities: [],
    }),
    {
      expectedVersion: 0,
      capabilityFreshnessSeconds: MIN_ADMISSION_FRESHNESS_SECONDS,
      allowedCapabilities: [],
    },
  );
  assert.ok(
    parseAdmissionPolicyPut({
      expectedVersion: 0,
      capabilityFreshnessSeconds: MAX_ADMISSION_FRESHNESS_SECONDS,
      allowedCapabilities: ["node_permission_model"],
    }),
  );

  for (const invalid of [
    {
      expectedVersion: 0,
      capabilityFreshnessSeconds: 3_599,
      allowedCapabilities: [],
    },
    {
      expectedVersion: 0,
      capabilityFreshnessSeconds: 2_592_001,
      allowedCapabilities: [],
    },
    {
      expectedVersion: -1,
      capabilityFreshnessSeconds: 86_400,
      allowedCapabilities: [],
    },
    {
      expectedVersion: 0,
      capabilityFreshnessSeconds: 86_400,
      allowedCapabilities: ["bubblewrap", "bubblewrap"],
    },
    {
      expectedVersion: 0,
      capabilityFreshnessSeconds: 86_400,
      allowedCapabilities: ["sandboxed"],
    },
    {
      expectedVersion: 0,
      capabilityFreshnessSeconds: 86_400,
      allowedCapabilities: [],
      trusted: true,
    },
  ]) {
    assert.equal(parseAdmissionPolicyPut(invalid), undefined);
  }
});

test("virtual default is explicit, complete and not a recorded decision", () => {
  assert.equal(DEFAULT_RUNNER_ADMISSION_POLICY.version, 0);
  assert.equal(DEFAULT_RUNNER_ADMISSION_POLICY.source, "default");
  assert.equal(
    DEFAULT_RUNNER_ADMISSION_POLICY.capabilityFreshnessSeconds,
    DEFAULT_ADMISSION_FRESHNESS_SECONDS,
  );
  assert.deepEqual(DEFAULT_RUNNER_ADMISSION_POLICY.allowedCapabilities, [
    "node_permission_model",
    "bubblewrap",
    "landlock",
    "seccomp",
    "user_namespace",
    "docker",
    "podman",
  ]);
  assert.equal(DEFAULT_RUNNER_ADMISSION_POLICY.updatedAt, undefined);
  assert.equal(DEFAULT_RUNNER_ADMISSION_POLICY.updatedBy, undefined);
});

test("policy timestamps advance monotonically across clock ties and regressions", () => {
  assert.equal(
    nextPolicyUpdatedAt("2026-07-26T12:00:00.000Z"),
    "2026-07-26T12:00:00.000Z",
  );
  assert.equal(
    nextPolicyUpdatedAt(
      "2026-07-26T12:00:00.000Z",
      "2026-07-26T12:00:00.000Z",
    ),
    "2026-07-26T12:00:00.001Z",
  );
  assert.equal(
    nextPolicyUpdatedAt(
      "2026-07-26T11:59:59.000Z",
      "2026-07-26T12:00:00.999Z",
    ),
    "2026-07-26T12:00:01.000Z",
  );
  assert.equal(
    nextPolicyUpdatedAt("2026-07-26T12:00:00Z"),
    undefined,
  );
});
