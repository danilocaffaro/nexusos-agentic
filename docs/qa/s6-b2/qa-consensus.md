# S6.B2 QA consensus

> Status: PASS
> Date: 2026-07-26

Fable, Opus and Codex converged on
`docs/adr/S6B2-versioned-leases-durable-outbox.md`.

Fable first replaced nonce-only replay with two independent mechanisms:
short-lived cryptographic nonce replay and a durable semantic operation
tombstone. Its second pass added a crash-safe per-operation local outbox,
stable operation ids, fresh signatures on retry and permanent non-reapplication
after exact response bytes are compacted.

Codex implemented the closed diagnostic control plane, signed routes, D1
invariant triggers, reference Node runner, local outbox recovery, UI timeline
and adversarial API/CLI tests. No shell, model provider, connector or user
payload is executed in this batch.

Opus blocked the first implementation on active-lease revocation, cancellation
convergence, equal-expiry renewal and incomplete race classification. After
those fixes and the required revoke-before-replay and zombie-fence tests, its
next review found one final retry classifier using an unreachable SQLite
message. Codex moved the real trigger classifier into the shared lease domain,
tested it directly and proved the trigger's actual message in migration QA.

The final Opus delta review returned `PASS` with no P0/P1 and explicitly
authorized the S6.B2 commit and S6.B3 start. Fable, Opus and Codex therefore
agree that diagnostic leases and durable replay are real under
`operator_trust`; arbitrary execution, sandboxing and streaming remain
roadmap.

Interactive browser acceptance is not included in this pass because the
in-app controller repeatedly timed out against the healthy local server. This
is recorded as a deferred pre-GA gate with build, SSR smoke and structural UI
tests as non-equivalent substitute evidence.
