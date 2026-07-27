# S6.B3.6 assignment and admission blueprint

> Architecture gate: Fable/Opus consensus `GO`
> Date: 2026-07-26

## Boundary

This batch makes assigned diagnostic routing and declaration-based admission
real. It does not execute arbitrary work, enforce a sandbox, attest a host,
stream output, schedule expiry or introduce a proprietary dependency.

The existing exact `{}` unassigned diagnostic and its claim response/event
metadata remain byte-compatible. An assigned run never falls back to another
runner.

## Normative decisions

- No policy row means a virtual default policy: version `0`, freshness
  `86400` seconds and the complete closed capability set allowed.
- The API labels that projection `source=default`; it is not represented as a
  recorded human decision.
- An explicit empty allowed set is valid and denies every capability-routed
  assignment.
- The first CAS write expects version `0` and creates version `1`.
- Freshness is an integer number of seconds from `3600` through `2592000`.
  Evaluation is inclusive and reuses `isCapabilityReportFresh`.
- `requiredCapability` is optional. Without it, admission is
  `assignment_only` and requires no report.
- Missing, stale, unknown, unavailable or disallowed declarations all fail
  closed as `capability_declaration_mismatch`.
- A lease records the exact admission inputs that commit. A stale policy or
  report pin aborts the batch and is re-evaluated from fresh heads.
- `assignment_only` records no policy or report pin because neither authorizes
  that decision.
- Admission denials are not memoized in runner nonces or operations and never
  increment `claim_count`.
- Policy and report GETs are pure. Derived expiry never writes history.

## Commit 1 — Governed policy

Add `runner_admission_policies`, keyed by organization:

- `version` starts at one and advances exactly by one;
- `capability_freshness_seconds`;
- `updated_by`, `created_at` and `updated_at`.

Add append-only `runner_admission_policy_versions`, keyed by organization and
version, with the exact freshness, actor and monotonic timestamp for every
committed policy. Add append-only `runner_admission_policy_capabilities`, keyed
by organization, policy version and closed capability, with a composite foreign
key to that immutable version record. Old freshness and allow-lists therefore
remain reconstructable after the mutable head advances. A version with zero
capability rows is deny-all.

Policy triggers reject invalid version/freshness, a non-owner/admin actor,
non-forward update or delete. Server-owned `updated_at` advances monotonically
through `nextPolicyUpdatedAt`, including two writes in one millisecond.
Version/capability update and delete are forbidden. A capability insert is
accepted only before its version's `runner_policy.updated` ledger event exists,
sealing a committed allow-list against later widening.

`GET /api/runner-admission-policy` is member-readable and returns either the
virtual default or the configured row. `PUT` is owner/admin only and accepts
exactly:

```json
{
  "expectedVersion": 0,
  "capabilityFreshnessSeconds": 86400,
  "allowedCapabilities": ["bubblewrap"]
}
```

The batch order is parent CAS, immutable version record, capability rows, then
one unguarded `runner_policy.updated` Decision Ledger insert. The version
primary key makes a lost CAS collide before any child can commit. A dedicated
ledger trigger accepts the event only when the just-written head and version
record match the actor and exact `nextPolicyUpdatedAt` value, and rejects a
second event for the same version. Therefore a zero-row CAS necessarily aborts
the complete batch. Ledger sequence conflicts roll back and retry from fresh
heads; re-read classification returns `policy_version_conflict` for a lost
CAS.

The ledger payload is metadata-only, hash-bound to freshness, canonical
allow-list, organization and new version, and uses a per-version reference.
Tests force zero-row create/update, same-millisecond actor collisions, empty
allow-lists and ledger-sequence races.

## Commit 2 — Assigned storage and backstops

Add nullable immutable `runs.assigned_runner_id` and
`runs.required_capability` through pure `ALTER TABLE ADD COLUMN` statements.
The migration may not rebuild or drop `runs`; single-column runner identity is
foreign-keyed while tenant equality is trigger-enforced and documented.

`run_leases` gains seven nullable immutable admission pins:

- `admission_basis`;
- `admission_policy_source`;
- `admission_policy_version`;
- `admission_freshness_seconds`;
- `admission_required_capability`;
- `admission_report_id`;
- `admission_report_received_at`.

An unassigned run requires all pins null. `assignment_only` requires only its
basis and all policy/report pins null. Capability admission requires every pin
and binds it to the assigned run, exact current policy head/version record and
exact latest report.

Run triggers require:

- capability implies assignment and belongs to the closed set;
- the assigned runner belongs to the run organization;
- runner and runner principal are active at creation;
- assignment fields never change after insert.

Migration 0023 replaces the existing lease `BEFORE INSERT` trigger in place;
there is exactly one such trigger and its ordered statements backstop:

- assigned runner and tenant equality;
- existing revoked/disabled checks;
- the pinned report and proof that no newer report exists;
- the pinned configured policy version, or absence plus default version zero;
- inclusive freshness relative to canonical server-issued lease time;
- `received_at <= issued_at`, so a future report always fails closed;
- `available` evidence for the required capability;
- exact-version configured allow-list, or the virtual default.

Freshness uses integer milliseconds only:
`CAST(strftime('%s', timestamp) AS INTEGER) * 1000 +
CAST(substr(timestamp, 21, 3) AS INTEGER)`. Julian-day floating point is
prohibited. The lease trigger first proves `issued_at` is a canonical
24-character UTC timestamp by the same round trip used for capability reports.
Every nullable admission condition is expressed as a positive `EXISTS` proof
whose absence aborts; SQL `NULL` can never mean allow.

Migration 0023 also replaces `run_events_validate_before_insert`.
`lease.claimed` JSON fields are null-safely compared with the committed lease
pins, including freshness. It also replaces
`run_leases_validate_before_update` so every admission pin is immutable.
Unassigned `{leaseId, operationId}` remains valid and byte-identical.

## Commit 3 — Claim-time admission

The claim path preserves nonce/operation replay and all unassigned behavior.
One shared evaluator serves both pre-batch and post-abort classification with
this fixed precedence:

1. inactive runner/principal: `runner_rejected`;
2. missing/cross-tenant/terminal/deadline/claim-cap/live lease:
   `run_unavailable`;
3. wrong same-tenant runner: `run_assignment_mismatch`;
4. existing runner conflict/busy;
5. capability admission, when requested;
6. guarded lease creation.

Admission is a pure server function of the active runner/principal, the latest
report, configured or virtual policy and canonical server time.

Unassigned `lease.claimed` metadata stays exactly `{leaseId, operationId}`.
Assignment-only metadata adds assigned runner and basis only. Capability
metadata mirrors all committed lease pins. Renew and complete remain
fence-authorized and do not re-evaluate admission.

The single lease trigger uses abort prefixes already recognized as run races:
`invalid_run_lease_assignment` and `invalid_run_lease_admission`. Every abort
is re-read through the shared evaluator before a bounded retry. Forced
multi-violation tests prove trigger ordering never selects the public error.

## Commit 4 — Assigned route and reads

`POST /api/runs/diagnostic/assigned` is owner/admin only and accepts exactly
`assignedRunnerId` plus optional `requiredCapability`. It validates an active
same-tenant runner but deliberately does not evaluate eligibility until claim.
Creation records assignment in the run event and hash-bound run ledger entry.

The run read contract exposes optional assignment fields and derived deadline
expiry. Existing cancellation owns the only mutation path after expiry.

For commits 2 and 3, assigned rows are seeded directly in private migration and
integration databases. Per commit, migration deploys before worker code.
There is no down migration or column drop. A code-only rollback can degrade an
existing assigned claim to `conflict_retry`, but storage still prevents
fallback or mis-routing.

Frozen byte surfaces are broader than the claim event: the unassigned
`run.requested` ledger preimage stays exactly
`{deadlineAt, kind, maxClaims, runId}`, unassigned `run.created` metadata stays
`{deadlineAt, kind}`, the `LeaseClaim` response never grows assignment fields,
and `DiagnosticRun.status` never gains `expired`.

## Frozen errors

| Condition | Code | Status |
| --- | --- | --- |
| Invalid policy body | `invalid_admission_policy` | 400 |
| Stale policy CAS | `policy_version_conflict` | 409 |
| Invalid assigned-run body | `invalid_assigned_run_request` | 400 |
| Missing/cross-tenant runner at creation | `runner_not_found` | 404 |
| Inactive runner at creation | `runner_not_active` | 409 |
| Wrong assigned runner at claim | `run_assignment_mismatch` | 409 |
| Declaration/policy mismatch | `capability_declaration_mismatch` | 409 |
| Revoked claim identity | `runner_rejected` | 403 |
| Non-member policy read | `workspace_membership_required` | 403 |
| Non-owner/admin policy write | `workspace_owner_required` | 403 |

## Required gates

- empty and populated forward migration;
- Node SQLite and Wrangler-local `json_extract` smoke;
- virtual default, configured empty policy and strict CAS;
- exactly one policy ledger entry and none on zero-row/failed CAS;
- monotonic same-millisecond policy updates;
- reconstructable immutable policy versions and sealed allow-lists;
- GET byte/row purity;
- run assignment tenant/lifecycle/immutability triggers;
- pure `ALTER TABLE` migration shape and populated forward upgrade;
- one ordered lease insert trigger and preserved trigger set;
- latest-report shadowing, future rejection and -1/0/+1 ms boundaries;
- wrong-runner, revoked and policy/report race classification;
- no fallback and no claim-count side effect on denial;
- lease scalar pins and event-to-lease JSON binding;
- lease update rejection for every admission pin;
- exact unassigned B2 claim response, event, ledger preimage and metadata;
- full B2/B3.5 chaos, preflight and migration regression;
- production build, smoke, audit, drift and independent Opus zero-P0/P1.

## Architecture conditions

1. B3.5 must land independently. Satisfied by commit `ba61a20`.
2. Policy CAS has a mandatory storage-triggered failure when it changes zero
   rows; application read-back alone is never treated as rollback.
3. Seven admission pins, including freshness, are committed on the lease and
   event-bound in storage.
4. There is one ordered lease insert trigger; forced concurrent violations use
   deterministic shared read-classification.
5. Integer-millisecond freshness must match the JavaScript oracle exactly.
6. No user-facing label may say attested, enforced, verified or sandboxed.
