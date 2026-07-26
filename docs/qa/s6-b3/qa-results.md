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
