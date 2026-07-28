# S6.B4.4a5.3 release evidence

## Outcome

B4.4a5.3 adds a dark, fair recovery-cycle boundary that keeps filesystem
preparation and finalization under borrowed state-lock ownership while every
injected completion effect runs outside the borrow. It adds no public command,
heartbeat loop, claim, prompt read, provider process, credential access or
network caller. Execution remains `roadmap`.

The new production module is import-inert. The existing runner does not import
it, and no capability label changes from roadmap to real.

## Architecture

`prepareEngineAttemptRecoveryHeld` performs bounded recovery under a borrow:

1. recover and safely prune settled attempt journals;
2. reconcile at most 32 actionable attempts;
3. create or adopt the deterministic `engine.complete` declaration;
4. persist the journal's `outboxed` commitment;
5. adopt already-terminal tombstones; and
6. select at most 16 pending effects.

Each frozen effect intent binds the attempt, operation, run and exact pending
entry checksum. Its request descriptor contains only the bounded canonical
body, body hash, pathname and signature domain. It contains no state
directory or lock capability.

`runEngineRecoveryCycle` invokes one injected effect at a time outside the
borrow and yields after every effect. A fresh borrow then:

- re-reads exactly one pending v3 declaration;
- requires the same operation, run and entry checksum;
- classifies a bounded data-only response artifact;
- transitions using the newly read entry, never the prepared snapshot;
- re-reads a terminal tombstone;
- requires the exact status, HTTP status, response hash and tombstone
  checksum; and
- persists the correlated attempt settlement before returning a terminal
  result.

A malformed effect envelope is normalized to a protocol halt by the cycle
runner. Accessors are never invoked and encoded response length is bounded
before decoding. The future HTTP adapter must still bound its streamed read to
64 KiB before creating the artifact.

## One-shot and concurrency contract

Only one active recovery plan may exist for one ownership capability. Plans
are private-registry bound to the exact capability and state directory.
Duplicate finalize, forged intent, crossed capability/state, finalize after
halt and complete while an effect is captured all fail closed.

The process-lifetime filesystem lock remains owned while effects run, but its
borrow is free. This permits a future heartbeat or lease renewal to borrow the
same capability between effects without permitting a second recovery cycle or
a duplicate delivery.

The pure lifecycle is:

- `BOOT -> RECOVER -> STEADY`;
- `STEADY -> RECOVER` when another cycle is due;
- any nonterminal phase -> `DRAINING` on stop;
- repeated stop while draining is idempotent;
- release success -> `STOPPED/released`;
- release failure -> `STOPPED/stale_possible`, with no release retry; and
- only durable, attributed authentication rejection ->
  `PERMANENT_STOP`.

Lifecycle states reject hidden keys, symbols, accessors and phase-field
contradictions.

## Recovery, retention and evidence

Every completed cycle re-correlates journals before considering outbox
pruning. Terminal pruning is suppressed when:

- any actionable attempt remains beyond the current 32-attempt window; or
- any terminal outbox operation correlated to a recovered journal still lacks
  a durable `settled` record.

This protects both the 33rd deferred attempt and a terminal settlement that
fails because of storage or journal safety. Future `pruneNowMs` values are
rejected; production uses the current clock.

Corruption discovered between effect and fresh borrow is quarantined, becomes
a protocol halt and remains visible in `report.corrupt.outbox`. Only
corruption of the exact current operation can trigger that downgrade. Storage
and resource failures continue to propagate.

Fresh journal cleanup now mirrors staged cleanup: after the atomic rename, a
non-infrastructure removal failure quarantines the staging tree, emits
evidence and continues an eligible sibling. `ENOENT` is success;
`EMFILE`, `ENFILE`, `ENOMEM`, `EDQUOT`, `EIO`, `ENOSPC` and `EROFS`
propagate.

## Legacy compatibility boundary

`coordinateEngineAttemptRecovery` and
`coordinateEngineAttemptRecoveryHeld` remain dark compatibility facades. Their
legacy `drainCompletions` callback combines HTTP classification and durable
outbox mutation, so it cannot satisfy the new effect-only boundary.

B4.4a5.4 must consume only `runEngineRecoveryCycle`. It must not activate
either combined facade. The future HTTP adapter must:

- stream-bound response bytes before base64url encoding;
- map transport, timeout, stream and protocol failures to the closed effect
  artifact vocabulary;
- preserve the real HTTP status;
- derive replay only from `x-nexus-replay === "1"`;
- issue effects serially and once per intent; and
- apply backoff for retryable/protocol halts instead of busy-looping.

## Automated acceptance

The focused acceptance matrix covers:

- borrow-free effects and serialized recovery;
- exact request body/hash/path/signature-domain binding;
- success, rejected, superseded, authentication, retryable and protocol
  classification;
- terminal response status/hash verification before settlement;
- hostile accessors, symbols, oversized base64url and corrupted outbox files;
- duplicate, forged, crossed, captured and post-halt plan use;
- stale prepared entries and restart adoption;
- 17 deliveries producing exactly 16 effects, 16 yields and one deferred
  sibling;
- reconcile-before-prune with an honestly old terminal tombstone;
- 33-attempt backlog retention;
- settlement-failure retention;
- fresh and staged removal quarantine with sibling continuation; and
- exact lifecycle and one-shot release-failure states.

The final focused gate passed 75/75 with ESLint and diff hygiene.

## Release gate

Fable selected this exact prepare/effect/finalize architecture and prohibited
activation of the combined sender. The first Opus 5 review returned NO-GO
solely because the one-shot guards lacked direct executable proof. Those
tests were added. Two exact delta reviews then returned PASS/GO with P0=0 and
P1=0. The final exact review also returned PASS/GO with P0=0, P1=0 and three
non-blocking P2 observations. Its documentation wording observation was
corrected before commit. The remaining observations are the intentional
legacy-facade restriction documented above and fail-safe message-string
coupling that aborts rather than weakening validation if the strings drift.

The repository-wide pipeline passed:

- typecheck;
- 251/251 unit tests;
- 226/226 runner tests;
- 38/38 migration and preflight tests;
- all seven API integration suites;
- production build and 2/2 rendered-artifact smoke tests;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities; and
- `git diff --check`.

The frozen attempt record, durable outbox, outbox contract, declaration
registry, supervised execution and production runner modules remain
byte-identical to the B4.4a5.2 base.

## Rollback

Rollback removes `engine-serve-cycle.mjs`, restores the coordinator and
journal-store implementation and removes the new tests and this evidence
record. No persisted schema, record vocabulary, command, provider process or
external state was introduced, so rollback strands no external effect.
