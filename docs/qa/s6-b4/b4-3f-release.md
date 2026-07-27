# S6.B4.3f release evidence

## Outcome

B4.3f is complete. NexusOS now materializes engine-run deadlines as immutable
terminal state instead of exposing expiry only as a derived read-side fact.
Due queued and leased `engine_prompt` runs converge to `expired` through the
organization-scoped `system:deadline-reconciler:v1` automation principal.
Provider/CLI execution, engine completion and prompt erasure remain inactive.

## Architecture decision

The release reuses the storage and validators introduced in migration 0025.
No schema migration or proprietary service is added.

Each due run is processed in one atomic D1 batch:

1. insert the deterministic immutable deadline operation
   `op_<run-id-hex>`;
2. for a leased run, revoke the exact active lease/fence with
   `deadline_exhausted`;
3. let the existing synchronous `run_leases_detach_after_update` trigger
   perform the single `leased -> queued` transition, clear the current lease
   and increment the version;
4. transition the exact queued run to immutable `expired` at the same
   `appliedAt`;
5. append the canonical `run.expired` event;
6. append the hash-chained `run.expired` ledger proof.

The batch order satisfies the existing trigger dependencies. Any zero-row,
stale-fence, terminal-state, actor, event or ledger failure aborts the entire
batch. The operation insert cannot survive without the terminal event and
ledger proof.

Fable reviewed the initial architecture and returned `GO`, P0=0. A live test
then exposed that the inherited detach trigger already performs the proposed
leased-to-queued update. A focused Fable delta review returned `GO` to remove
the redundant no-op statement, conditional on pinning the exact trigger body.
The migration suite now verifies its active-to-non-active edge, queued state,
lease detachment, single version increment and fenced run guard.

## Entry points and bounds

- The Worker cron invokes one scheduled pass every minute.
- The local operator command invokes the same scheduled-mode repository
  operation through a loopback-only, local-mode-only endpoint.
- Authenticated engine create, claim, renew and prompt-read handlers schedule
  an independent maintenance pass with `waitUntil` only after the
  authoritative operation succeeds. Each Worker isolate permits at most one
  such pass in flight and applies a 30-second cooldown; scheduling and
  execution failures cannot alter the authoritative request response.
- Scheduled/local selection is capped in SQL at 100 rows.
- Mutation-time selection is capped in SQL at 25 rows.
- Every pass orders work by `deadline_at, id` and processes candidates
  sequentially, prioritizing candidates with a current mapped actor and
  coherent lease state so a fail-closed row cannot strand healthy backlog.
  It therefore does not race its own organization ledger head.
- The exact inclusive boundary is `deadline_at <= observedAt`.

The local endpoint returns 404 unless local identity is explicitly enabled.
It accepts only an exact empty body and fixed operator header. Its test-time
clock header is honored only while test identities are enabled.
The CLI accepts only loopback HTTP targets, including canonical IPv6
loopback, and refuses redirects.

## Concurrency and effect-once behavior

The immutable operation primary key resolves same-run sweeps. A losing sweep
waits briefly and verifies the complete run/operation/event/ledger effect
before classifying the result as a benign skip. An operation tombstone without
the terminal proof is reported as inconsistent rather than accepted.

Different runs in the same organization can race on the ledger sequence.
Those batches roll back on the unique sequence constraint, reread the ledger
head and retry with a newly computed predecessor and hash. Runs inside one
pass remain sequential. A per-run failure does not prevent later candidates
from being evaluated, and the result reports only opaque run ids and closed
failure codes.

Cancellation and expiry use commit order as the authority. An already
terminal canceled run is not selected. A still-live engine run with a pending
cancel request can expire, preserving the immutable cancellation markers.
After expiry, claim, renew, prompt read and diagnostic completion paths remain
closed by their existing storage and domain guards.

## Audit and privacy

The event metadata is exactly:

```json
{
  "deadlineAt": "2026-07-27T12:20:00.000Z",
  "operationId": "op_11111111111111111111111111111111",
  "reason": "engine_deadline_exhausted"
}
```

The ledger payload hash covers those fields plus the opaque run id. Logs and
maintenance results contain only counts, closed error classes and opaque run
ids. No prompt reference, prompt digest, ciphertext, plaintext, model
credential or runner key is selected or logged.

## Health

`/api/system/health` now reports only
`deadlineReconciliation.overdue`. The signal becomes overdue when a queued or
leased engine run remains at least ten minutes beyond deadline. No tenant or
run timestamp is exposed by the unauthenticated health surface. This is an
operational warning while the database remains reachable, so it does not turn
an otherwise healthy endpoint into HTTP 503.

## Automated evidence

The release candidate covers:

- canonical operation identity, metadata, ledger payload and 25/100 bounds;
- exact deadline boundary and ten-minute health cutoff;
- queued and genuinely leased expiry against isolated Wrangler/D1 storage;
- synchronous lease detachment, version progression and
  `deadline_exhausted`;
- two concurrent sweeps with one effect per run and an unbroken ledger chain;
- replay with zero additional operation, event or ledger rows;
- overdue health before reconciliation and healthy state afterward;
- loopback local CLI and rejection of an unauthenticated local request;
- post-expiry claim, renewal and prompt-read denial;
- full trigger-body migration tripwire;
- absence of engine completion, provider execution and prompt-erasure routes.
- production build output containing the exact every-minute scheduled trigger
  and scheduled Worker export.

The final release gate passed:

- 208 unit tests;
- 91 local-runner tests;
- 32 migration and storage tests;
- all seven isolated live API integration suites, including the real local
  deadline operator CLI and concurrent effect-once expiry;
- production build and two rendered/Worker artifact smoke tests;
- TypeScript, ESLint and Oxlint;
- schema generation with no drift;
- production dependency audit with zero vulnerabilities at the configured
  high-severity gate;
- `git diff --check`.

The final independent Claude Opus 5 delta review returned `PASS`, release
`GO`, P0=0 and P1=0. Its non-blocking P2 findings were the absence of explicit
poisoned-row priority and truncation/failure-path tests, the hostname form of
the loopback-only CLI target and the deliberately closed 503 result for a
persistently malformed candidate. The first two are acceptance criteria for
B4.3g; the latter two remain explicit local-operator hardening items.

## Rollback

Disable the cron and remove the code-only scheduled, local and mutation-time
entry points plus the deadline repository/domain modules. No migration is
rolled back. Already-expired runs, immutable operations, ended leases, events
and ledger proofs remain valid historical facts. Re-upgrade resumes from
remaining queued or leased due rows.

## Next batch

B4.3g activates one-way prompt retention after terminal state. It must
crypto-shred only ciphertext material after the frozen retention window,
retain opaque integrity metadata and converge through the same scheduled,
local and mutation-time maintenance pattern. Engine provider execution
remains inactive until B4.4. The batch must also exercise a poisoned deadline
candidate ahead of healthy backlog plus the reconciliation truncation and
failure-count paths, closing the two test-depth findings from the B4.3f Opus
review.
