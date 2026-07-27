# S6.B4.2b release evidence

## Outcome

B4.2b is complete. NexusOS now receives and retains a signed, privacy-safe
inventory of the optional Claude Code and Codex CLI engines declared by an
operator-controlled runner. Engine execution, prompt delivery and provider
turns remain unavailable.

Delivered:

- append-only engine report and ordered evidence storage with tenant/runner
  ownership, strict metadata grammar, immutable rows and bounded replay-body
  compaction;
- a forward-only policy migration that gives current and historical rows the
  86400-second engine freshness default without rewriting history;
- explicit rollback compatibility: prior-release policy writers succeed while
  freshness remains at 86400 and fail atomically after a non-default decision;
- a shared signed-declaration route and physical nonce store whose hashes bind
  domain, pathname and body, preserving capability-report behavior while
  rejecting cross-domain nonce reuse;
- signed engine-report POST with exact replay, monotonic server receive time,
  transactional report/evidence/nonce/liveness mutation and acknowledgement
  derivation before mutation;
- pure, tenant-authorized keyset history GET with 50-row pages, privacy-safe
  reconstruction, non-negative age and no request or declaration hashes;
- atomic policy CAS across capability allow-list, capability freshness and
  engine freshness, including immutable history, post-write verification and
  the Decision Ledger payload hash;
- governed UI editing and strict client parsing for both independent freshness
  windows;
- fail-closed reconstruction with the precise `engine_report_failed` code and
  final-schema assertions that preserve handwritten inline freshness checks
  across future migrations.

No executable path, provider identity, credential, OAuth state, environment,
prompt, stdout, stderr or vendor free-text error is stored by this batch.
Execution, Sandbox and Streaming remain `roadmap`.

## Automated gates

Reproduced locally on 2026-07-25:

- typecheck: pass;
- unit: 175/175;
- runner: 43/43;
- migrations/preflight: 24/24;
- governance, presence, realtime, artifacts, runners and runs integrations:
  pass;
- production build and rendered smoke: pass;
- ESLint and oxlint: pass;
- production dependency audit: zero vulnerabilities;
- Drizzle generation: no schema changes;
- diff hygiene: pass.

The runner integration includes canonical signature and body rejection, exact
and semantic replay, cross-domain nonce reuse, concurrent duplicate delivery,
50-row keyset pagination, tenant isolation, horizon compaction, privacy
scanning, partial-storage fail-closed behavior and a configured 3600-second
policy producing an exact 1800-second report acknowledgement.

## Independent implementation review

Opus 5 reviewed the complete B4.2b implementation statically and reproduced
unit and migration gates. The first result was:

- verdict: PASS;
- P0: 0;
- P1: 0;
- P2: 3 non-blocking observations;
- release decision: GO.

All three observations were resolved before release. The final schema now pins
the handwritten engine-freshness checks through both post-0024 and
all-migrations `sqlite_master` assertions. A deliberately incomplete stored
report has an end-to-end fail-closed regression. Declaration repository errors
retain their precise code through the workspace route.

The Opus delta review again returned `PASS`, P0=0, P1=0 and `GO`. Its remaining
P2 identified that the constraint assertion also needed to run after future
migrations; the shared final-schema assertion now does so. The full local
pipeline was then reproduced from the final commit candidate.

## Rollback

The migration is forward-only and additive. Server rollback is supported:
runners that do not send engine reports continue to work, and the new policy
columns retain the 86400 default. A prior-release policy writer is compatible
only while engine freshness is still 86400; at a non-default head, storage
rejects the incomplete write atomically and preserves current state, immutable
history and ledger lineage.

Engine report rows may remain dark during a server rollback. They confer no
execution authority and expose no new claim or lease path.

## Next batch

B4.2c adds the real local filesystem and bounded process adapters, runner
configuration commands and outbox-v3 delivery. It must keep paths and raw
provider output local, use fixed shell-free argv, serialize all state changes
under the runner lock and preserve v1/v2 downgrade behavior. Engine execution
remains prohibited.
