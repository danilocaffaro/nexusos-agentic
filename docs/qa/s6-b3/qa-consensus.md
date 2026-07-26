# S6.B3 design consensus

> Status: PASS for implementation
> Date: 2026-07-26

Fable, Opus and Codex converged on
`docs/adr/S6B3-capability-admission-trust-boundary.md`.

The first Fable proposal usefully separated declared, observed, tested and
enforced states, but it still overstated Node's Permission Model and local tool
presence as isolation. Codex rejected that implication and the mutable latest
profile, nonce-only replay and non-atomic lease-drain portions. Fable's second
pass reduced the real scope to signed host assertions plus server-owned
admission.

The first Opus adversarial review found seven P0 defects: a cross-run lease
deadlock, unsafe legacy migration, insufficient semantic idempotency,
outbox-v1 incompatibility, probe-command injection surface, overstated trust
vocabulary and a partially bounded revoke. The accepted ADR closes all seven
with a fail-loud first-statement index, cross-run expiry convergence, permanent
report tombstones, v1/v2 compatibility, fixed local probes,
`hostReported`/`eligible` vocabulary and a single bounded revocation batch.

The final Opus review returned `PASS`, zero P0 and authorized B3.1. It recorded
six non-blocking P1 items with these owners:

1. This consensus record makes design closure auditable in B3.1.
2. `docs/PROGRAM-PLAN.md` no longer calls the B3 boundary `enforced`.
3. Periodic reports run at most every 12 hours against a default 24-hour
   freshness window; B3.1 freezes the edge oracle.
4. B3.2 implements bounded oldest-first nonce cleanup and response compaction
   only inside report mutations; GET remains pure.
5. B3.1 separates v2 storage from the legacy v1 directory; B3.3 proves binary
   downgrade preserves and later resumes v2 entries.
6. B3.5 ships an operator preflight/reconciliation command before the
   fail-loud unique-index migration.

Amendment, 2026-07-26: the accepted mutation-purity invariant is unchanged,
but delivery is split at the reversible batch boundary. B3.2 creates the
guarded nonce/compaction storage; B3.3 activates bounded cleanup and compaction
inside the first signed report mutation. This amendment supersedes only the
batch assignment in item 4 and preserves the original record above.

This is a design gate, not an implementation or release pass. Capability
reporting, storage, probes, policy admission and UI remain incomplete until
their respective small batches pass automated and Opus implementation review.
