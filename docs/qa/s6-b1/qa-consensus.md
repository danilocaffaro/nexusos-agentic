# S6.B1 QA consensus

> Status: PASS
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

Implementation then passed 101 unit, five CLI, four migration, five API
integration, build, smoke, lint, dependency-audit and schema-drift gates. A real
UI-issued token enrolled a local Ed25519 runner, a signed heartbeat projected it
as `Online`, and desktop plus 390 × 844 browser acceptance passed.

The first Opus CLI/UI review returned `BLOCK` on two P1 findings: a rejected
retry could delete the only key retained after an ambiguous success, and the UI
guessed its signing audience from `window.location.origin`. Codex corrected
both, added regression tests, made configured audience canonical and
server-authoritative, bounded chunked responses, suppressed interactive stdin
echo and removed every secret-bearing error echo. The final Opus delta review
returned `PASS` with no residual P0/P1.

Fable, Opus and Codex therefore agree that `S6.B1` is complete. Identity and
heartbeat are real under `operator_trust`; leases, engines, execution, sandbox,
streaming and outcome evidence remain roadmap and do not inherit this pass.
