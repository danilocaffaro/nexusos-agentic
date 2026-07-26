# S6.B1 QA consensus

> Status: DESIGN PASS / IMPLEMENTATION PENDING
> Date: 2026-07-26

Fable, Opus and Codex converged on
`docs/adr/S6B1-signed-runner-enrollment.md` after three adversarial passes.

The initial design was blocked because it did not safely handle concurrent
single-use token consumption, a lost enrollment response, configured audience,
idempotent nonce replay, strict public-key validation or ledger contention.
Fable replaced interactive branching with deterministic identities and guarded
D1 statements. Opus then found and closed a foreign-key ordering error, a
self-referential signature body, non-atomic heartbeat state and missing
token-revocation proof.

The frozen design uses detached Ed25519 signatures, configured audience,
byte-exact request hashing, principal → runner → token → ledger ordering,
whole-batch retry, exact heartbeat response replay and explicit
`operator_trust`. Direct repository inspection corrected one Opus assumption:
Drizzle's text enum does not emit a SQLite `CHECK`, so the ledger kind extension
is additive and never rebuilds existing proof.

The final Fable review returned `PASS` with zero P0. Its four non-blocking
precision deltas are incorporated: enrollment proof is guarded by
`consumed_runner_id = RID`, heartbeat replay follows active-state
authentication, heartbeat body is exactly `{}`, and timestamps require
uppercase `Z` with exactly three fractional digits.

Implementation, exhaustive automated evidence, real CLI enrollment and
desktop/mobile acceptance are still required before this file can become a
release PASS.
