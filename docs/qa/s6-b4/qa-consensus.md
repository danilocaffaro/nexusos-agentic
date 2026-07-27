# S6.B4 architecture consensus

## Decision

The S6.B4 architecture is accepted for B4.1. NexusOS will orchestrate local
Claude Code and Codex CLI processes through an open `ExecutionEngine` port. It
will not embed either CLI as the platform kernel. Engine execution is optional
for NexusOS and assigned-only for an engine run.

## Independent review sequence

1. Fable defined the adapter/port boundary and recommended reuse behind a
   vendor-neutral contract.
2. The first Opus 5 review failed with P0=3/P1=8. The design removed prompt
   plaintext from durable replay, replaced a filesystem key assumption with a
   Worker binding keyring and proved the 4096-byte completion envelope.
3. The second Fable review returned an architecture pass with P0=0 and two
   pre-implementation P1 hardenings. The design added a lease-pinned version
   re-probe and a complete 0600 scratch lifecycle.
4. The first Opus delta failed with P0=0/P1=3. The design added bidirectional
   diagnostic/engine route guards, a valid recoverable/prunable outbox-v3
   acknowledged variant and a realizable audited deadline terminal path.
5. The final Opus 5 delta passed with P0=0/P1=0. It independently rechecked
   all prior P0/P1 findings against the live B3 schema, route, repository and
   runner substrate.

The six final P2 recommendations were absorbed before implementation: a
storage-validated `run.expired` ledger proof, immutable pinned engine admission
on renew, immutable expired state, storage-exact engine admission shapes, an
operation-bound engine receipt discriminator and the production cron location
and sweep bounds.

## Tool evidence

- Claude Code CLI `2.1.219` and `2.1.220`, model Fable for architecture and
  Opus 5 for gates.
- The unsupported Codex CLI `0.145.0` env-node wrapper was diagnosed, while
  native `0.146.0-alpha.3.1` alone passed the exact flags, auth status and
  stable feature vocabulary matrix against the installed CLI and current
  local OpenAI manual.
- Review sessions were read-only and did not edit files or run package
  managers/tests.

## Release rule

B4.1 may start. B4.2–B4.5 remain gated by their batch-specific tests. One-shot
CLI execution stays `roadmap` until B4.5 passes full regression, real local
acceptance, browser truth checks and a final Opus review with P0=0/P1=0.

## B4.1 implementation gate

B4.1 subsequently passed the full repository pipeline and the final Opus 5
implementation confirmation with P0=0, P1=0 and P2=0. B4.2 may start;
execution remains `roadmap`.

## B4.2c implementation-readiness gate

Fable reviewed the released B4.2a probe/outbox core and B4.2b signed server
substrate against the live runner. It returned `PASS`, P0=0, P1=0 and `GO`.
Six P2 observations became locked design constraints before code:

- v3 classifies 410 as `rejected` with response, never legacy `abandoned`;
- no-follow executable open also uses non-blocking mode against FIFO swaps;
- the process port carries an explicit validated cwd;
- real fixture executables live below a 0700 operator-owned tree;
- fail-closed macOS group-write behavior is disclosed instead of weakened;
- probes terminate process groups with TERM, grace and KILL, not immediate
  KILL.

The accepted implementation order is real adapters, local config/inspect,
side-effect-free report assembly, v3 delivery/fault recovery and real-local
evidence. The server, routes, schema and UI remain unchanged throughout
B4.2c; execution remains `roadmap`.

## B4.2 architecture gate

A subsequent Fable implementation-readiness review returned P0=0/P1=4. Before
B4.2 code, the design moved the complete outbox-v3 base into B4.2, removed the
unprovable metadata-only full-argv canary, pinned read-only auth-status commands
with an `unknown` fallback and required the B4.2 migration to recreate the
runner-admission-policy history validators. Local evidence proved that a
complete 16036-byte Claude Code 2.1.219 help capture contains the planned
flags, but the CLI still exits zero when an unknown flag precedes `--help`.
B4.2 therefore reports only metadata/auth readiness; B4.4b remains the first
full argv and provider-turn gate.

The Fable delta review then returned `PASS`, P0=0/P1=0 and `GO` for B4.2a.
Its four non-blocking P2 notes were absorbed before code: indeterminate auth
collapses the whole probe to unknown with no version, local replacement of an
undelivered report is `abandoned`, every scrubbed v3 terminal is pruned after
seven days, and the truncated 8192-byte help capture was replaced by the
complete bounded capture.

The first Opus B4.2a implementation review returned `FAIL`, P0=0/P1=3. It
identified multiple canonical encodings through BOM stripping, false Codex
readiness on exit code alone and a new clock-order rule that could quarantine
frozen v1/v2 outbox work. All three were corrected with direct regression
tests. The nine P2 findings were also absorbed before requesting the delta
review; B4.2a remains unreleased until Opus confirms P0=0/P1=0.

The Opus delta returned P0=0/P1=1. The remaining blocker was JavaScript
coercion allowing Number/BigInt device or inode values through a decimal
regex. The implementation now requires exact string types before pattern
validation and rejects both lossy Number and unserializable BigInt facts. The
seven new P2 findings were also incorporated, including prototype-safe
registry lookup, a self-contained runner constants module with parity gate, a
shared declaration-hash golden and CLI reachability tests proving a recovered
v3 entry remains pending while diagnostic and capability-report flows complete
normally.

The final Opus B4.2a review returned `PASS`, P0=0/P1=0 and `GO` for the full
release pipeline. Its two non-blocking P2 observations were absorbed before
release: the device/inode Number/BigInt regression matrix now covers both
fields, and the numbered QA traceability list is contiguous. Codex then
reproduced every automated gate locally, including the full migration and API
integration suite, production build, smoke, lint, zero-vulnerability
production audit and no-schema-drift confirmation. B4.2a is complete and
B4.2b may start; execution remains `roadmap`.

## B4.2b implementation-readiness gate

Fable reviewed B4.2b against the live 0023 schema, repositories, signed route
wrapper, policy UI and integration harness. It returned `PASS`, P0=0 and
`GO`, with four mandatory P1 corrections incorporated before code:

- use `ADD COLUMN NOT NULL DEFAULT 86400` as the only backfill mechanism,
  because current/history triggers forbid update-based history mutation;
- give engine evidence its own storage version grammar, including safe spaces
  and parentheses accepted by the signed contract;
- define and test prior-release policy-write behavior after a forward-only
  migration, including atomic fail-closed behavior at non-default freshness;
- include `engineFreshnessSeconds` in the policy ledger payload hash and
  post-write verification.

Six P2 refinements were also accepted: recreate only four affected policy
triggers, keep Drizzle's additive-column model compatible with the handwritten
SQL constraints, compact engine response bodies through shared bounded
cleanup, update the client policy parser atomically, repeat the full engine
consistency matrix in storage and derive acknowledgements before mutation from
the monotonic receive time. B4.2b may now start in schema, shared declaration,
server inventory, policy and release-evidence batches.

## B4.2b implementation gate

The implementation landed as separate storage, shared-transport, signed
inventory and policy commits. The complete Opus 5 review returned `PASS`,
P0=0, P1=0 and `GO`. Its three P2 observations were absorbed: final-schema
tests pin the handwritten inline freshness checks, partial stored evidence has
a fail-closed integration case and declaration reconstruction failures retain
the precise private error code.

The Opus delta review again returned `PASS`, P0=0, P1=0 and `GO`. Its final P2
showed that the inline-check assertion had to run after all future migrations,
not only immediately after 0024; one shared assertion now covers both states.
Codex then reproduced the full local pipeline, zero-vulnerability production
audit and no-schema-drift gate. B4.2b is complete and B4.2c may start;
execution remains `roadmap`.

## B4.2c first implementation gate

The first Opus 5 implementation review returned `FAIL`, P0=0 and P1=3. The
delta now binds the closed engine declaration into the local change
fingerprint so Claude login and logout cannot collide, supports the locally
verified Claude Code 2.1.219 and 2.1.220 metadata contracts, and creates a
private ephemeral 0700 probe directory below runner state instead of relying
on stock Linux `/tmp`.

All five P2 findings were also absorbed before delta review: help explains the
fail-closed path policy, engine-internal failures stay inside the locked exit
set, every resolved cwd parent is checked, cooperative TERM exits do not burn
the grace interval and all engine filesystem fixtures live below the
operator-owned workspace tree. B4.2c remains gated until Opus returns zero
P0/P1 and the real-local plus full-pipeline evidence passes.

The first delta resolved all eight findings but returned `FAIL`, P0=0/P1=1.
The remaining blocker showed that the installed Codex 0.145.0 wrapper needs a
Node interpreter excluded by the literal PATH, while the installed native
0.146.0-alpha.3.1 passes the complete metadata/auth matrix. The native version
is now pinned. Four P2 hardenings also moved scratch beside the key-bearing
state directory, added bounded stale-crash sweeping, made dry-run validate
state 0700 and corrected the installed-CLI evidence. A final delta is still
required.

Before that final delta, a real-runner acceptance exposed one additional
transport defect: Node-created pipes silently retained only 8192 of the 16036
Claude help bytes. Codex reproduced the same result across environment, stdin
and process-group variants, then rejected AF_UNIX and FIFO after both produced
the same truncation. A memory-only pre-established TCP loopback transport
captured all bytes. Fable first proposed unlinked regular files, then reviewed
the new evidence and changed the architecture verdict to TCP loopback because
regular files violate the no-raw-output-at-rest invariant and provide only a
polled soft bound.

The final Fable delta returned `GO` with mandatory tuple identity, closed
listeners before spawn, one-second setup deadline, all-resource cleanup and
hard per-stream caps. Direct tests now cover address/port mismatch, partial
setup cleanup, exact 16 KiB, 16 KiB plus one, cooperative and hostile
overflow, timeout, early close and a grandchild retaining inherited streams.
The real macOS dry-run reports Claude 2.1.219 as available and compatible and
a private copy of the native Codex 0.146.0-alpha.3.1 as ready, both without
truncation. The final Opus delta remains the release gate.

That Opus review independently reproduced the 8192/16036 transport behavior,
the real CLI matrices, listener closure, child descriptor isolation and zero
residual handles. It returned `FAIL`, P0=0/P1=1/P2=6. The blocker was an
unconsumed rejection on the accepted-socket promise during pre-connect setup
failure: resources were closed, but a later unhandled rejection could abort
the runner outside its CLI error grammar.

The corrective delta attaches a rejection consumer at promise creation and an
error recorder to every accepted reader before the second pair begins. Unknown
transport errors become the closed `EIO` process result, which the pure probe
grammar accepts only as failure. The unsupported 0.145.0 wrapper was removed
from the compatibility allowlist; stale sweeping now additionally requires a
real operator-owned 0700 directory. New direct tests cover a foreign process
winning the first accept, closed listeners, no extra child socket descriptor,
single timeout rejection, closed setup-error grammar, invalid second-pair
cleanup, unsafe/file/symlink sweep leaves and explicit `EIO` non-success.

Two non-blocking trade-offs remain documented rather than weakened: the exact
version allowlist makes the 348-byte Claude help headroom deterministic and
fail-closed, while lexicographic selection preserves the 32-entry hard sweep
work bound and becomes eligible again as earlier entries age out. A final Opus
delta must still confirm P0=0/P1=0.

The final Opus delta independently reproduced the full runner suite, the
16036-byte Claude capture, the native Codex dry-run and the load-bearing
unhandled-rejection fix. It returned `PASS`, P0=0/P1=0/P2=4 and `GO`.
The remaining defensive socket-listener P2 was absorbed immediately by
attaching the recorder before the accept-count branch, so rejected secondary
sockets are covered too. Dry-run intentionally does not sweep because it does
not hold the outbox lock; a later locked delivery reclaims its bounded empty
0700 remnant. B4.2c may enter the full release pipeline; execution remains
`roadmap`.

Codex then reproduced the complete release pipeline after the final defensive
listener change: lint and typecheck, 175 unit tests, 91 runner tests, 24
migration tests including real Wrangler, all six API integration suites,
production build and rendered smoke. Drizzle reported no schema drift,
`git diff --check` passed and the production dependency audit reported zero
vulnerabilities. The real Claude/Codex dry-run was also repeated with
`truncated:false`. B4.2c is complete and B4.3 may start; engine execution
remains `roadmap`.
