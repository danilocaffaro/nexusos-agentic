# S6.B3 QA results

## B3.1 — Pipeline parity and frozen contract

> Status: PASS
> Date: 2026-07-26

Delivered:

- accepted architecture record and auditable Fable/Opus/Codex consensus;
- explicit ownership for all six non-blocking design P1 findings;
- GitHub CI runner-test parity;
- strict canonical capability-report v1 parser and checked-in fixture;
- stable declaration hash and exact 12-hour/24-hour freshness-edge oracle;
- frozen outbox-v1/v2 parser, derived paths and checked-in fixtures;
- rollback-safe sibling storage contract for future v2 entries;
- no report endpoint, persistence or capability claim activated.

Automated evidence:

- 111 unit tests passed;
- 11 reference-runner and outbox-contract tests passed;
- five migration suites passed from empty and historical schemas;
- governance, presence, realtime, artifacts, runners and runs API integrations
  passed;
- production build and rendered smoke passed;
- typecheck and lint passed;
- Drizzle generated no migration or schema drift;
- production dependency audit reported zero vulnerabilities;
- `git diff --check` passed.

The first Opus implementation review returned `BLOCK` with zero P0 and two
P1 findings. The corrected delta now rejects free-form version/path content,
uses the frozen validator in the live v1 reader and exercises checked-in v1
recovery plus real sibling-v2 preservation. Its related P2 findings are also
closed: canonical bounded freshness, domain-separated declaration hash,
composed report/outbox fixtures and a consistent 128 KiB entry envelope.

The Opus delta review confirmed both original P1 findings closed and found one
final local P1: the v2 envelope report id was not bound to the signed body id.
It explicitly authorized commit without another review after equality was
enforced, the normative fixture was corrected and focused tests passed. Those
conditions are satisfied: the parser now rejects identity drift even under a
recomputed checksum, the live reader rejects an altered v1 path, and it applies
the 128 KiB bound before reading. Empty declarations also fail structurally.

The focused post-fix gate passed 111 unit and 11 runner tests plus typecheck,
lint and diff check. The immediately preceding full post-review regression
passed every migration/integration, build, smoke, audit and drift gate. B3.1 is
therefore complete and B3.2 may begin.

## B3.2 — Append-only report storage and pure read APIs

> Status: PASS
> Date: 2026-07-26

Candidate delivered:

- three tenant-bound capability-history tables with composite runner foreign
  keys, closed-value checks and bounded field constraints;
- storage triggers that reject replacement, semantic report mutation, evidence
  mutation and report/evidence deletion;
- narrowly permitted one-step replay accounting and one-way response
  compaction, with explicit guards against combining them;
- monotonic authoritative receive time per runner, independent of untrusted
  host collection time;
- a pure keyset-paginated report-history read route with a fixed 50-row page;
- one-query latest-declaration projection for the runner registry, avoiding
  per-runner reads and omitting internal hashes and stored response bytes;
- explicit `hostReported` disclosure while capability profiles, sandbox,
  execution and streaming remain `roadmap`;
- additive upgrade proof from the exact S6.B2 schema.

The Fable architecture review returned `GO-WITH-CONDITIONS`. Its three P0
conditions are implemented: composite organization/runner identity,
replacement-proof append-only triggers and exhaustive report-update guards.
Its P1 conditions are also implemented: monotonic receive time, keyset indexes,
SQL bounds, additive upgrade, pure GETs and bounded query shape.

Automated candidate evidence:

- 113 unit tests and 11 reference-runner/contract tests passed;
- six migration suites passed, including empty and S6.B2 upgrade paths;
- governance, presence, realtime, artifacts, runners and runs API integrations
  passed against local D1;
- the runner integration proved 51-row keyset pagination, tenant concealment,
  real `INSERT OR REPLACE` rejection, and unchanged row counts and replay
  totals across GET requests;
- production build exposed the new GET route and rendered smoke passed;
- typecheck, lint and `git diff --check` passed;
- Drizzle reported no residual schema change;
- production dependency audit reported zero vulnerabilities.

The first Opus implementation gate returned `BLOCK` with zero P0 and two P1
findings. The corrected candidate now guards both the evidence primary key and
capability unique index against `INSERT OR REPLACE`, with a byte-preservation
regression, and restricts latest-declaration work to the exact runner page
(maximum 100) using one indexed latest-row seek per runner. Related P2
corrections align `RESTRICT` foreign keys with the schema snapshot, preserve
the original consensus plus a dated amendment, exercise distinct cursor
timestamps and empty history, distinguish unexpected query parameters, prove a
populated S6.B2 upgrade, and accurately describe GET-purity evidence.

No signed report POST, nonce cleanup, response compaction job, local probe,
admission policy or workload execution is activated in this batch. B3.3 owns
the report mutation lifecycle and outbox-v2 delivery.

The Opus delta review returned `PASS`, zero P0/P1 and `COMMIT AUTHORIZED: yes`.
It confirmed both original P1s closed for the right reasons and independently
inspected their regressions, tenant scope, bind ordering, SQLite/D1 semantics,
schema/snapshot alignment and documentation. Its non-blocking write-path
observations are explicit B3.3 entry conditions: make the monotonic receive-time
lookup seek the organization/runner history index and activate only bounded
nonce deletion. Empty-cursor strictness and the defensive projection-limit
error remain low-risk read-path polish; schema version stays pinned to v1.
B3.2 is complete.

## B3.3a — Signed server mutation plane

> Status: PASS
> Date: 2026-07-26

The Fable architecture gate returned `GO-WITH-CONDITIONS`. The server candidate
implements its zero-tolerance conditions:

- path/key/audience/body-bound Ed25519 reports with uniform unauthenticated
  rejection;
- separate signed-request and nonce-independent semantic hashes;
- active-before-replay plus storage-backed revocation race protection;
- atomic report, ordered evidence, 201 nonce response and liveness commit;
- byte-exact nonce and semantic replay, deterministic nonce/report conflict,
  permanent compacted-id `410` and concurrent duplicate convergence;
- bounded oldest-first mutation maintenance with GET purity unchanged;
- trigger-only, populated-upgrade-tested index-seekable monotonic receive time;
- no report ledger entry and no capability-label promotion.

Local D1 integration exercises fresh apply, exact nonce replay, changed nonce,
semantic retry, permanent conflict, concurrent same-id delivery, path/key
mismatch, body bounds, 100-row cleanup/compaction, zero-write `410`,
revocation-before-cached-replay and ledger non-contention. Those focused checks
were followed by the full regression and independent implementation gate.

The full gate passed 113 unit, 11 runner-contract, six migration and all six
API integration suites, plus build/SSR, rendered smoke, typecheck, lint,
production audit with zero vulnerabilities, Drizzle no-change and diff check.
The independent Opus implementation review returned `PASS`, zero P0/P1 and
`COMMIT AUTHORIZED: yes`. It confirmed every server-relevant Fable condition
closed.

Non-blocking P2 follow-up remains explicit: consolidate the duplicated signed
route preamble, thread stored success status through replay nonce creation,
classify exhausted receive races as transient, require the exact canonical
pathname, add a concrete query-plan assertion and extend end-to-end clock
regression coverage. None changes the signed-report trust boundary or blocks
B3.3b. B3.3a is complete.

## B3.3b — Durable runner report delivery

> Status: PASS
> Date: 2026-07-26

The runner candidate now writes only outbox-v2 envelopes into the sibling
`outbox-v2` directory while continuing to read, deliver and transition
checked-in outbox-v1 claim/completion envelopes in place. A simulated
downgraded v1 scan leaves v2 bytes untouched and a subsequent upgrade resumes
the exact entry. Operation identifiers are collision-checked across both
directories, pruning syncs the directory actually changed and mixed-version
recovery has one deterministic order.

`nexus-runner report-capabilities` persists the canonical report and fsyncs it
before its first signed request. Restart resumes the oldest pending capability
report before creating a new one. Crash injection proves both critical
boundaries: after durable persistence but before send, and after server effect
but before local acknowledgement. The latter replays the same report bytes and
produces one semantic server effect. The command reports replay/recovery
explicitly and never stores a pathname supplied by the host.

The production baseline is intentionally honest: all seven bounded
capabilities are `unknown` with detection `none` and reason
`probe_disabled`. `--dry-run` creates no state directory, performs no network
request and prints that canonical baseline. Fixture injection is rejected
outside explicit test mode. CLI version is `0.3.0`; static probes, admission
policy, workload execution and any sandbox claim remain inactive.

Automated candidate evidence:

- 114 unit tests and 13 runner/outbox tests passed;
- six migration suites and all six API integration suites passed;
- production build and rendered smoke passed;
- typecheck, lint and `git diff --check` passed;
- Drizzle reported no residual schema change;
- the production dependency audit reported zero vulnerabilities.

The focused runner suite covers dry-run non-effects, forbidden production
fixture injection, v1/v2 transition locality, rollback preservation,
post-persist recovery, post-send semantic replay and byte-identical retry.
The independent Opus implementation review returned `PASS`, zero P0/P1 and
authorized commit after the focused gates were repeated. Its requested ADR
reconciliation is applied. The candidate also closes its highest-value
non-blocking test gap by sending the runner's real seven-item production
baseline through the production capability parser; rollback preservation is
now asserted byte-for-byte and outbox inspection exposes each envelope version.

Remaining P2 follow-up is explicit: give operators a governed resolution for a
pending report from a previous runner identity; harden unexpected non-201 2xx
classification; reduce duplicated runner/server enum definitions; make
dry-run's ignored state-dir behavior explicit; remove redundant recovery scans;
document the outbox-lock dependency of cross-directory collision checks; and
extend error, mixed-kind and mixed-version pruning coverage. None permits a
wrong-identity send, data loss or an overstated capability claim.

## B3.4 — Bounded static local probes

> Status: PASS
> Date: 2026-07-26

The reference runner now collects seven canonical, host-declared capability
items through a frozen runner-only matrix. Fixed absolute binaries run with no
shell, empty environment, ignored stdin, private bounded pipes and a three
second deadline. POSIX probes run in a private process group so timeout or
overflow kills descendants. Fixed proc sources use bounded reads. Only strict
digits-and-dots version captures or exact bounded proc fields can produce
`available`; every ambiguous result fails closed.

Landlock still has no probe and remains `unknown/none/probe_disabled`.
Bubblewrap never influences it. Docker and Podman remain unknown on unprobed
operating systems rather than being called unavailable. Node Permission Model
support is disclosed only as a filesystem guardrail, never a sandbox. The
user-namespace result explicitly remains configuration evidence and does not
claim that a later child can bypass AppArmor or another host policy.

The signed report, append-only server history, outbox-v2 envelope and both
crash boundaries are unchanged. `NEXUS_RUNNER_DISABLE_PROBES=1` is a
reduce-only escape hatch back to the all-unknown baseline. The injected probe
root used by deterministic tests is rejected outside explicit test mode. CLI
version is `0.4.0`; admission, arbitrary workload execution, streaming,
sandbox enforcement and UI trust-label changes remain out of scope.

Focused candidate evidence:

- 114 unit tests passed, including the real CLI body crossing the production
  capability parser;
- 22 runner/outbox/probe tests passed;
- typecheck, lint and `git diff --check` passed;
- strict, malformed, privacy-marker, missing, permission, proc, cross-OS,
  timeout, overflow and descendant-kill cases passed;
- a deterministically probed body survived post-persist and post-send crashes,
  replayed byte-identically and leaked no hostile probe output into its signed
  body or decoded outbox entry.

The full regression subsequently passed all six migration/API integration
families, production build, rendered smoke, lint and diff check. The production
dependency audit found zero vulnerabilities and Drizzle reported no schema
change.

The first Opus implementation review returned `GO`, zero P0/P1 and authorized
commit. Before closing, its inexpensive P2 hardening was absorbed: probes now
run concurrently while preserving canonical order; group/world-writable or
foreign-owned candidate binaries are not executed; child pipe errors are
classified; the deadline timer remains referenced; bounded files are read to
EOF or cap rather than assuming one complete read; and injected roots are
restricted to the system temporary directory. The descendant test now records
the spawned child PID and proves it no longer exists after collection, while a
separate stderr-overflow path and Node failure mappings are covered.

The Opus delta review also returned `GO`, zero P0/P1 and authorized commit. It
confirmed the parallel order, ownership checks, complete bounded reads,
referenced deadline, stream-error handling, process-group guard, temporary
test-root boundary and PID-based descendant proof. Its last two code nits are
closed: Seccomp whitespace cannot cross a line and an injected test executable
can no longer inherit the parent Node version. Both Opus sessions were
static-only because their sandbox denied test execution; the complete local
gates above were executed by Codex on the exact candidate tree.

Remaining non-blocking follow-up is explicit: fixed probe paths can produce a
conservative false absence for custom installations; downstream UI must say
"not found at fixed probe paths"; seccomp and user-namespace availability must
remain configuration evidence rather than containment; and Windows may return
an honest Node false-negative under an empty child environment. None activates
admission, execution or sandbox enforcement. B3.4 is complete.

## B3.5a — Operator lease preflight

> Status: PASS
> Date: 2026-07-26

The first lease-convergence small batch is operator-only. It adds no schema
index and changes no request path. A repository-local command lists multiple
active leases for one runner without mutation, chooses one survivor by the
total order `(expires_at DESC, issued_at DESC, id DESC)`, and requires explicit
`--apply` before closing losers.

Reconciliation is two-phase and restart-safe. Phase one marks only losers
`preflight_reconciled`; the existing detach trigger requeues their runs. Phase
two derives missing `lease.superseded` events from storage, uses the runner
principal as actor and supports multiple missing leases on one run through
ordered window sequences. Both phases return changed identities directly, so
local and remote Wrangler executions expose exact counts without relying on
the local runtime's omitted `meta.changes`.

List-only mode verifies both active duplicates and missing reconciliation
events and exits non-zero for either. Remote execution is never inferred and
requires an explicit config. The checked-in Wrangler process has no shell, a
one-MiB output limit, a 60-second per-operation deadline and signal propagation
to its whole process group. Operator output contains only opaque runner, lease
and run ids, fences and timestamps.

Automated evidence:

- 114 unit and 22 runner/outbox/probe tests passed;
- 12 migration/preflight tests passed, including a real temporary local D1,
  `UPDATE ... RETURNING`, `INSERT ... RETURNING`, a phase-one crash, recovery
  and an idempotent rerun;
- all six API integration families passed unchanged;
- production build and rendered smoke passed;
- typecheck, lint and `git diff --check` passed;
- production dependency audit reported zero vulnerabilities;
- Drizzle reported no schema change.

The first Opus gate returned `BLOCK`, zero P0 and two P1 findings: list mode
could falsely clear a phase-one crash, and local counters depended on a
Wrangler metadata field that is not returned locally. Both were corrected and
covered through the real CLI. The delta gate returned `PASS`, zero P0/P1 and
authorized commit once the locally observed migration suite was green. Its
non-blocking sequence-allocation concern is also covered, its non-zero
`UPDATE ... RETURNING` gap is closed, Ctrl-C now terminates the child group and
URL paths in the real CLI test are decoded safely.

Remaining P2 follow-up is explicit: failed Wrangler execution deliberately
returns a closed error instead of echoing potentially sensitive stderr, and
the five apply-mode operations have individual rather than aggregate
deadlines. B3.5b owns claim/revoke convergence; B3.5c owns the fail-loud unique
index migration.

## B3.5b — Claim and revoke convergence

> Status: PASS
> Date: 2026-07-26

The runtime now enforces at most one active lease per runner even before the
schema index lands. Claim reads at most two active rows. A live foreign lease
returns opaque `runner_busy`; legacy multiplicity returns fail-loud
`runner_conflict`; and an expired foreign lease is superseded with its old-run
event in the same D1 batch that grants the new run.

The new lease insert repeats the runner invariant inside its write statement.
A concurrent winner makes it insert zero rows, after which the required
runner-operation trigger aborts and rolls back the whole batch. Replay is
checked first; race classification then re-reads the runner/principal, at most
two active leases and the target run before returning a permanent rejection,
stable busy/conflict or bounded fresh-head retry.

Revocation accepts zero or one active lease. Its single batch disables the
runner principal, revokes that lease and appends its event, revokes the runner,
and inserts an unguarded required ledger entry. The ledger trigger forces the
entire batch to roll back unless the runner transition really occurred. Every
success re-reads storage and requires zero active leases. An already-revoked
runner with one residual is healed without duplicating the runner ledger;
two rows remain an operator-preflight conflict.

The reference runner preserves its exact durable claim entry for 5xx, 429,
`runner_busy`, `runner_conflict` and `conflict_retry`, exits retryably and
resumes the same operation id later. Definitive lease/run failures remain
terminal.

Automated evidence:

- 114 unit and 23 runner/outbox/probe tests passed;
- 12 migration/preflight tests passed;
- all six API integration families passed;
- run integration covers live foreign busy, later retry, expired cross-run
  convergence, claim-side and revoke-side legacy conflicts, already-revoked
  residual healing, two concurrent cross-run claims, event-head contention
  and both claim/revoke orders;
- production build and rendered smoke passed;
- typecheck, lint and `git diff --check` passed;
- production audit reported zero vulnerabilities;
- Drizzle reported no schema change.

The first Opus implementation gate returned `PASS`, zero P0/P1 and authorized
commit after the local suite. Its pre-index concurrency concern, terminal
`runner_conflict`, over-broad permanent retry and missing behavioral gates were
then closed. The delta gate again returned `PASS`, zero P0/P1 and authorized
commit on the exact locally green candidate. Both reviews were static-only
because their sandbox denied command execution; Codex ran the full gates above.

Remaining P2 follow-up is explicit: unique-constraint classification is broad
inside the bounded revoke retry, fast-path and post-race error precedence are
not identical for an already-unavailable target, and migration 0021 must align
its global runner-id scope with the runtime's tenant-qualified defensive
query. None permits two committed leases, false revocation success or durable
outbox loss. B3.5c owns the storage index.

## B3.5c — Active runner lease storage invariant

> Status: PASS
> Date: 2026-07-26

The final lease-convergence batch makes one active lease per runner a database
invariant. Drizzle migration 0021 contains one statement only: a partial unique
index on `run_leases.runner_id` for rows whose status is `active`. Its generated
qualified predicate is byte-aligned across schema, migration, snapshot and
documentation.

The upgrade path fails loudly. A populated legacy database with duplicate
active leases cannot create the index and retains an unchanged `sqlite_master`.
The same behavior is proven through the real local Wrangler migration runner:
the failed migration creates neither the index nor a `d1_migrations` record.
After the restart-safe operator preflight closes losers and appends their
missing events, migration 0021 applies and records exactly once.

Legacy runtime conflict coverage remains explicit without weakening production
storage. The runs integration temporarily removes the index only in its private
ephemeral D1, creates the two-row legacy condition, proves deterministic
`runner_conflict` from claim and revoke, invokes the real preflight, restores
the checked-in generated migration bytes and verifies the index before
continuing. Normal empty-database and all API integrations run with 0021 active.

Automated evidence on the exact candidate:

- 114 unit tests and 23 runner/outbox/probe tests passed;
- 13 migration/preflight tests passed, including real Wrangler failure,
  bookkeeping rollback, reconciliation, successful retry and index creation;
- all six API integration families passed, including the post-index runs suite;
- production build and rendered smoke passed;
- typecheck, lint and `git diff --check` passed;
- production dependency audit reported zero vulnerabilities;
- Drizzle reported no schema changes.

The first Opus gate found one P0: the legacy chaos fixture still attempted its
duplicate insert after 0021. That was independently reproduced by the full
local regression and corrected. The delta gate returned `PASS`, zero P0/P1,
after statically validating the local-only drop/reconcile/restore boundary,
Wrangler bookkeeping and runtime compatibility. Both Opus sessions were
static-only because their sandbox denied test execution; Codex ran every gate
above locally.

Remaining P2 follow-up is test-only: the runs integration can assert the
operator-visible requeue/event shape after its app-created lease is reconciled,
and its Wrangler error regex follows human-readable CLI formatting in addition
to the durable bookkeeping assertions. Neither affects production behavior.
B3.5 is complete; B3.6 owns assigned diagnostics and policy admission.
