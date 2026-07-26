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
