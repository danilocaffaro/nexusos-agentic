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

## B3.6a — Governed runner admission policy

> Status: PASS
> Date: 2026-07-26

The first assignment/admission small batch establishes a human-owned,
organization-scoped policy without activating assigned execution. An absent
row projects a side-effect-free version-zero default with 24-hour freshness
and the complete closed capability set. A configured policy supports an
explicit empty allow-list, which is deny-all.

Owner/admin PUT uses strict compare-and-swap. The D1 batch writes the mutable
head, an immutable version record, zero or more immutable capability rows and
one metadata-only `runner_policy.updated` Decision Ledger event. A lost create
collides on the head primary key; a lost update is forced to abort by the
version insert trigger even when the head update changes zero rows. A ledger
sequence race rolls back and retries from fresh heads. The committed allow-list
is sealed once its ledger event exists.

Every policy version remains reconstructable from append-only rows. Database
triggers independently prove the actor is an active human owner/admin in the
same organization, forbid historical updates/deletes and bind the ledger actor,
timestamp and per-version reference to the exact committed head. Member GET is
pure; non-member reads and non-owner/admin writes fail closed. Post-commit
responses read the exact immutable version rather than a concurrently advanced
head.

Automated evidence on the exact candidate:

- 117 unit tests and 23 runner/outbox/probe tests passed;
- 15 migration/preflight tests passed, including empty and populated
  0021-to-0022 upgrades, failed-CAS rollback, deny-all, actor rejection,
  historical immutability and allow-list sealing;
- all six API integration families passed;
- the runner integration covered the virtual default, pure GET, member access,
  strict invalid bodies, two concurrent version-zero writes, canonical payload
  hashing, stale-CAS byte preservation, monotonic version two deny-all, real
  Wrangler/D1 trigger failure and local `json_extract`;
- production build and rendered smoke passed;
- typecheck, lint and `git diff --check` passed;
- production dependency audit reported zero vulnerabilities;
- Drizzle reported no schema changes.

The full development-tool audit separately reported ten high-severity issues
in the fast-moving Vite/Cloudflare/React-RSC toolchain and transitives. No new
dependency was introduced by this batch and the production-only audit is
clean. Toolchain upgrades are isolated into the next security maintenance
small batch so potentially breaking dependency changes do not contaminate the
governed policy commit.

The first Opus implementation gate returned `PASS`, zero P0/P1. Its four
actionable P2 findings were closed: actor revocation now maps to the frozen 403
contract, post-commit readback is version-immutable, non-object bodies map to
`invalid_admission_policy`, and the populated forward migration is exercised.
The delta gate again returned `PASS`, zero P0/P1 and confirmed all load-bearing
CAS, sealing, ledger, authorization and tenant properties. Both Claude sessions
were static-only because their sandbox denied test execution; Codex ran every
gate above locally.

B3.6a is complete. B3.6b owns additive assigned-run storage and immutable
admission pins; assignment and capability admission remain inactive until
their storage backstops and claim path ship together.

## Toolchain security maintenance — post-B3.6a

> Status: PASS
> Date: 2026-07-26

This isolated maintenance batch closes the development-tool vulnerabilities
discovered after B3.6a without changing the assignment/admission contract.
React, Vite, Cloudflare's Vite integration, Wrangler and the static-analysis
toolchain were upgraded as one lockfile-consistent unit. A narrowly scoped
`@esbuild-kit/core-utils` override removes its obsolete esbuild while preserving
Drizzle Kit's generated-schema behavior.

Removing `eslint-config-next` also removed thirteen React, accessibility and
module rules that were part of the prior gate. The replacement is explicit:
ESLint 10 owns JavaScript, TypeScript, Next.js and React Hooks analysis, while
the checked-in Oxlint configuration restores those exact thirteen rules at
error severity. Both analyzers share the generated-output exclusions. Two
lint-driven source edits are semantics-preserving: the attention cleanup no
longer returns from `finally`, and the shell-quote regex drops an unnecessary
escape without changing its matched bytes.

Automated evidence on the exact candidate:

- the complete dependency audit, including development dependencies, reported
  zero vulnerabilities;
- `npm ls --all` completed successfully, with only platform-conditional
  optional peers;
- 117 unit tests and 23 runner/outbox/probe tests passed;
- 15 migration/preflight tests passed through Wrangler 4.114.0;
- all six API integration families passed against real ephemeral D1 databases;
- production build on Vite 8.1.5 and rendered smoke passed;
- typecheck, the combined ESLint/Oxlint gate and `git diff --check` passed;
- Drizzle reported no schema changes after the scoped esbuild override.

The first Opus supply-chain gate found one P1: removing the monolithic Next.js
configuration had silently reduced React and accessibility coverage. After
restoring the exact rule surface in Oxlint, the second gate found one packaging
P1 because the configuration was not yet tracked. The final delta gate verified
the tracked configuration, automatic discovery, shared ignore boundary and all
thirteen error rules, then returned `PASS`, zero P0/P1. Claude's sandbox
performed static review; Codex ran all executable gates locally.

The toolchain maintenance batch is complete. B3.6b can now proceed on a clean,
audited baseline.

## B3.6b — Assigned storage and immutable admission pins

> Status: PASS
> Date: 2026-07-26

Migration 0023 adds assignment without activating it. `runs` gains a nullable
runner reference and closed required capability; `run_leases` gains the seven
immutable scalar pins that will make a later admission decision
reconstructable. All nine storage changes are pure `ALTER TABLE ADD COLUMN`
statements. No table is rebuilt, renamed or dropped.

The database now forbids fallback. An assigned run can be leased only by its
exact active same-tenant runner. Assignment-only leases carry only their basis;
unassigned leases carry no admission fields; capability-routed leases require
every policy and report pin. Positive `EXISTS` proofs bind the lease to the
latest report, available evidence, exact current configured policy version or
the absent-policy version-zero default, the exact allow-list and an inclusive
integer-millisecond freshness window. Future reports, shadowed reports,
unknown/unavailable/missing evidence and explicit deny-all all fail closed.

Run assignment fields and all seven lease pins are null-safely immutable.
`lease.claimed` events are storage-bound to the committed lease with exact
metadata shapes of two, four or ten keys. The established unassigned
`{leaseId, operationId}` bytes remain unchanged.

Automated evidence on the exact candidate:

- 117 unit tests and 23 runner/outbox/probe tests passed;
- 22 migration/preflight tests passed, including pure additive shape,
  populated forward upgrade, no-fallback, lifecycle and every nullable
  immutability direction;
- real Wrangler/Workerd D1 executed assignment-only and capability admission,
  four- and ten-key events, exact freshness, max-plus-one rejection and
  rollback with zero `claim_count` side effect;
- the SQL timestamp expression matched `Date.parse` across millisecond,
  calendar, leap-day, year and pre-epoch edges;
- admission expectations were derived from the production
  `isCapabilityReportFresh` oracle rather than duplicated literals;
- the fail-closed matrix covered absent, stale, cross-runner, unknown,
  unavailable and missing declarations, invalid basis/pins/timestamps/types,
  configured-policy absence, deny-all and all seven virtual-default
  capabilities;
- all six API integration families passed with migration 0023 active,
  including the unchanged B2/B3.5 claim, replay, fencing, revocation,
  cancellation, ledger and tenant paths;
- production build and rendered smoke passed;
- typecheck, combined ESLint/Oxlint, `git diff --check`, complete dependency
  audit and Drizzle drift gates passed.

Fable returned `GO` with conditions on null-safe comparison, latest-report
tiebreak, integer milliseconds and real forward-migration proof; all were
implemented. The first Opus implementation gate found zero semantic defects
and zero P0, but blocked on three missing proof gates. After adding real
Workerd coverage, differential oracle comparison and the complete denial
matrix, its delta review returned `PASS`, zero P0/P1. The one recommended P2
was also closed by comparing the exact runtime capability and metadata-key
contracts against the SQL rather than repeating test literals. Claude's
sandbox performed static review; Codex ran every executable gate locally.

B3.6b is complete. B3.6c owns the shared claim-time evaluator, guarded pin
commit and deterministic public error classification; assigned creation and
reads remain inactive until their later route batch.

## B3.6c — Claim-time assignment and capability admission

> Status: PASS
> Date: 2026-07-26

The claim path now evaluates active identity, run availability, assignment,
runner concurrency and capability admission through one pure, precedence-ordered
domain oracle. The same evaluator is used before the write batch and after
every storage-triggered abort. Revoked identity therefore wins over all other
conditions; run unavailability, including a live current lease, wins over
assignment and runner conflicts; assignment mismatch wins over capability
facts; and declaration mismatch is returned only after all higher-precedence
conditions pass.

One transactional D1 read snapshot supplies the runner/principal state, run
head, active runner leases, current policy/version/allow-list and latest
report/evidence. The absent policy remains an application-projected virtual
default rather than a recorded decision. The latest declaration uses the same
receive-time/report-id ordering as storage and freshness reuses the production
JavaScript oracle. Any policy, report, runner or run change after the snapshot
is independently rejected by migration 0023's trigger; the whole batch rolls
back, fresh heads are reclassified and a bounded retry recomputes every pin.

The admitted result is a discriminated union. Unassigned, assignment-only and
capability-declaration variants are the single source for both the seven lease
binds and the `lease.claimed` metadata. This preserves the exact two-key
unassigned bytes, produces exactly four assignment keys and exactly ten
capability keys. The public `LeaseClaim` response remains the same canonical
five-key document in all three modes. Denials occur before any write batch and
are not recorded in lease nonces or operations; they do not increment
`claim_count`. Renew and complete remain fence-authorized and deliberately do
not re-evaluate a later policy or declaration change.

Automated evidence on the exact candidate:

- 121 unit tests passed, including a table-driven multi-violation precedence
  matrix, inclusive freshness, report-id tie-breaking, malformed policy facts
  and exact metadata projections;
- 23 runner/outbox/probe tests and 22 migration/preflight tests passed;
- all six API integration families passed against real ephemeral Workerd/D1;
- the runs integration proved wrong-runner denial without mutation,
  assignment-only pins, missing-report denial followed by success with the
  exact same signed nonce, virtual-default pins, configured deny-all,
  same-request policy repair, latest-unknown shadowing and later restoration;
- changing the policy to deny-all after a capability claim did not invalidate
  renew or complete, proving admission is claim-time only;
- unassigned, assignment-only and capability responses/events were asserted as
  exact canonical bytes, with event metadata bound back to committed lease
  pins;
- production build and rendered smoke passed;
- typecheck, combined ESLint/Oxlint, `git diff --check`, complete dependency
  audit and Drizzle drift gates passed.

Fable returned `GO` with two mandatory conditions: replace the old
post-abort-only classifier because its ordering was wrong, and re-read active
runner/principal state before the first batch. Both are structural properties
of the implementation. The first Opus implementation gate returned `PASS`,
zero P0/P1, after independently checking tenant isolation, D1 batch semantics,
JS/SQL parity, rollback, retry and byte surfaces. Four inexpensive P2
hardening items were closed: route warm-up under the short test TTL, realistic
seed deadlines, exact assigned response bytes and a single canonical latest
report row. The Opus delta gate again returned `PASS`, zero P0/P1. Claude's
sandbox performed static review; Codex ran every executable gate locally.

The intentional compatibility change is documented: when a legacy-corrupt
runner has multiple active leases and the target run itself has a live current
lease, the frozen precedence now returns `run_unavailable` instead of the old
`runner_conflict`. B3.6c is complete. B3.6d owns the public assigned-create
route and assignment fields in run reads.

## B3.6d — Assigned creation and pure run reads

> Status: PASS
> Date: 2026-07-26

The public `POST /api/runs/diagnostic/assigned` path now lets an active human
owner/admin create a diagnostic for one active same-tenant runner, with an
optional capability from the closed declaration vocabulary. Its parser accepts
only the exact one- or two-field request. Missing and cross-tenant runners are
indistinguishable `404` responses; same-tenant inactive runners return the
frozen `409`.

Creation validates identity and lifecycle only. It deliberately does not read
the admission policy or capability reports: a deny-all organization can still
record an assigned request for a runner with no report, while claim remains the
single eligibility decision point. Assignment and optional capability are
hash-bound into the `run.requested` Decision Ledger preimage and copied into
the canonical `run.created` metadata in the same atomic D1 batch.

The insert trigger remains the create-versus-revocation authority. A bare
`invalid_run` abort is classified through a fresh tenant-scoped runner and
principal read without broadening the claim-path race classifier. Permanent
revocation therefore yields `runner_not_active`, while an unrelated anomaly is
bounded by the existing retry limit.

Run detail and list reads now expose assignment fields when present and a
derived `expired: true` only for overdue non-terminal runs. Server time is
captured once per request. Neither GET mutates the run, events or ledger;
`status` remains the frozen four-value state machine, and the existing owner
cancel path owns the only recorded transition after deadline.

The unassigned compatibility surfaces remain exact: its route still accepts
only `{}`, the fresh response gains no keys, the `run.requested` preimage stays
`{deadlineAt, kind, maxClaims, runId}`, `run.created` metadata stays
`{deadlineAt, kind}`, and every lease response/event remains the B2/B3.6c
canonical shape.

Automated evidence on the exact candidate:

- 123 unit tests passed, including strict assigned parsing and inclusive
  deadline derivation with terminal-state exclusion;
- 23 runner/outbox/probe tests and 22 migration/preflight tests passed;
- all six API integration families passed against ephemeral Workerd/D1;
- the runs integration exercised owner, admin, malformed, missing,
  cross-tenant and revoked creation; exact assigned and unassigned event and
  ledger hashes; configured deny-all with a no-report runner; public-route
  assignment-only and capability claims; and detail/list GET purity;
- an overdue assigned run remained `queued`, derived `expired: true` on both
  reads without row/event/ledger changes, and then canceled through the
  existing governed mutation;
- production build exposed the assigned route and rendered smoke passed;
- typecheck, combined ESLint/Oxlint, `git diff --check`, complete dependency
  audit and Drizzle no-drift gates passed.

Fable returned `GO` with mandatory conditions on optional read fields,
tenant-scoped runner lookup, local bare-`invalid_run` classification, claim-time
eligibility and distinct assigned/unassigned canonical objects. All are
structural properties of the candidate. The Opus implementation gate returned
`PASS`, zero P0/P1 and authorized commit after independently checking every
frozen surface, race, authority, tenant, ledger and claim-compatibility
boundary. Its inexpensive parser, contract-typing and list-read-purity P2s
were closed; migration-level hardening and shared-route precedence observations
remain explicitly non-blocking.

B3.6 is complete. B3.7 owns declared-capability history, policy explanation,
assigned-diagnostic/expiry presentation and the final trust-boundary release
gate. Execution, Sandbox and Streaming remain `roadmap`.

## B3.7 C0–C2 — Local schema and bounded declaration projection

> Status: PASS
> Date: 2026-07-26

C0 added idempotent local D1 migration before development startup. The existing
state upgraded from migration 0018 through 0023 without data deletion, a
second application found no pending migrations and a separate empty state
applied all 24 migrations non-interactively. The previously failing local
runner and run reads both returned 200 afterward.

C1 extracted the declaration clause from the claim admission oracle without
changing claim precedence, error codes or lease pins. Its differential matrix
covers default, configured, deny-all and partial allow-list policy; available,
unavailable, unknown, omitted, absent, malformed, stale and future reports;
invalid policy; multi-violation precedence; and the exact inclusive freshness
boundary. Opus first found two P1 explanation defects, which were closed by
making future, omitted and not-evaluated states explicit and freezing every
projected field. The delta review returned `PASS`, zero P0/P1.

C2 added one organization policy plus a bounded per-runner
`declarationAdmission` projection to the registry. One canonical
`evaluatedAt` drives declaration age and all seven closed-capability
evaluations. The projection contains no `eligible` result, keeps report pins
and `freshUntil` derived from the oracle-validated report and leaves
`capabilityProfiles` as `roadmap`.

The runner integration proves virtual default, configured deny-all,
cross-tenant default isolation, bounded seven-capability output, report pins,
no `eligible` key and zero mutations across report, policy, event and ledger
tables. Policy reads fail closed if mutable head facts diverge from their
immutable version. Typecheck, lint, 124 unit tests, the runs integration and
the runner integration passed. Opus returned `PASS`, zero P0/P1; its two
highest-value P2 hardenings for validated pins and nullable SQL join rows were
applied and the gates repeated successfully.

## B3.7 C3a — Truthful declaration summary

> Status: PASS
> Date: 2026-07-26

The Runners page now separates `DECLARADO · hostReported · não verificada`
from platform `REAL` and deferred `ROADMAP` states. Each runner exposes the
latest declaration, authoritative server receipt and age, host-provided
collection time and platform, truncation, policy source/version/window,
server-derived freshness deadline and all seven closed-capability explanations.
The visible boundary says that the complete decision is re-evaluated at claim.

The first Opus implementation review returned `FAIL` with three P1s: premature
B3 release copy and nonexistent history claim, no always-visible Portuguese
unverified qualifier, and accidental 16px browser-default policy typography.
All three were corrected at their source. The delta review returned `PASS`,
zero P0/P1.

Typecheck, lint, six component tests including a rendered declaration fixture,
production build and rendered smoke passed. Browser QA after a clean reload
proved an expanded 980px desktop card with three 306px policy columns and
8px/7px definition typography. At 390x844 the card measured 354px, policy and
capability grids collapsed to one column and document scroll width equaled
client width. A transient HMR error observed while helpers were being added did
not recur after reload of the complete candidate.

## B3.7 C3b — Inline declaration history

> Status: PASS
> Date: 2026-07-26

History now loads only after an explicit action, consumes the existing opaque
server cursor without parsing it, preserves server order, removes duplicate
report ids and keeps already-rendered rows across a failed next page. Closing
the declaration detail unmounts the history component, aborts the request and
invalidates its monotonic request id, so a late response cannot repopulate the
runner card. Malformed payloads and a runner-id mismatch fail closed.

The first Opus implementation review returned `FAIL`, zero P0 and two P1:
request actions lost keyboard focus when their controls disappeared, and
loading/completion live regions were mounted together with their messages.
The action is now a permanent focus target using `aria-disabled` plus guarded
re-entry, while one permanent atomic status region changes content. The error
path explicitly restores the same action; deterministic cursor failures
restart from page one. The repeated disclosure, uncleared focus timer and
overbroad “complete history” claim were also removed.

An isolated browser interception returned 503 only for the history fetch.
While pending, the action remained focused, exposed `aria-disabled=true` and
the status announced loading. After failure it remained focused and enabled
as “Tentar novamente”, alongside an alert; the real retry kept the stable
action focused and announced that no report exists. At 390x844 the card measured
354px, history 294px, result 272px, action 34px and document client/scroll
width both measured 390px. Desktop client/scroll width both measured 1280px.
The clean candidate produced no browser console errors.

The final Opus delta review returned `PASS`, zero P0/P1. Its remaining focus
and empty-cursor P2 hardenings were applied before commit: an empty cursor now
fails closed, completion only moves focus while the initiating action still
owns it, an empty page keeps that stable focus target and first-load failure
copy no longer claims that prior rows were preserved.

## B3.7 C4a — Dedicated policy edit authority

> Status: PASS
> Date: 2026-07-26

The dedicated policy response now carries `viewerCanEditPolicy`, computed from
the same active membership row that authorizes GET. One shared, type-narrowing
owner/admin predicate drives both the advertised permission and PUT authority;
the runner registry remains unchanged. Successful PUT responses return the
same closed shape with permission true.

The runners integration proves owner read/write true, admin read/write true,
member read false and member write 403. The existing before/after row snapshot
continues to prove GET read purity, and the external-server test mode retains
its owner fallback when it cannot seed an admin fixture. Typecheck, lint, the
admission-policy unit suite, full runners integration and diff check passed.
Opus returned `PASS`, zero P0/P1; its role typing, shared-predicate, external
fixture and QA-evidence hardenings were applied before commit. The owner/admin
authority join was also aligned to require the principal and membership to
belong to the same organization.
