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

## B3.7 AGECON amendment — 2026-07-26

Codex and Fable completed independent blind analyses of the trust-boundary UI.
They agreed on truthful `hostReported` disclosure, authoritative server receive
time, inline keyset history, explicit truncation, CAS without silent retry,
claim-time authority, derived expiry and promoting capability profiles to
`REAL` only in the final release commit.

Fable found that the accepted ADR promised an admission-policy result in the
runner registry while the current contract exposed only declaration facts.
Codex objected to a client-side or runner-level `eligible` state because the
full claim also depends on run, assignment, deadline, claim budget and leases.

Opus performed the reveal and adversarial round. Consensus is `GO` with the
following binding resolution:

1. Extract a pure declaration clause from the claim oracle and reuse it for a
   bounded, side-effect-free registry projection.
2. Name the projection `declarationAdmission`; never expose a top-level
   `eligible` boolean or imply a routing guarantee.
3. Return organization policy once and include server `evaluatedAt`; the UI
   explains that claim re-evaluates every condition.
4. Use inline progressive disclosure, not a modal drawer.
5. Return edit permission from the dedicated policy route; do not narrow
   viewer access to the runner registry.
6. Isolate dirty policy drafts from polling, freeze the original CAS version
   and preserve the draft after conflict.
7. Run idempotent local D1 migrations before `npm run dev`.

Implementation is split C0 through C6 in
`docs/qa/s6-b3/b3-7-blueprint.md`. Any implementation that names a runner
`eligible`, duplicates admission math in the client, or promotes Sandbox,
Execution or Streaming to `REAL` is `NO-GO`.

## B3.7 release amendment — 2026-07-26

C5 passed after independent Fable and Opus implementation reviews converged on
one truthful assigned-run surface: exact pool bytes, one assigned mutation,
no fallback, claim-time authority, preserved removed identities and
race-isolated reads.

The first C6 Opus release review returned `FAIL`, zero P0 and one P1 because
the promised truth-label gate was absent. Codex accepted the finding and added
authoritative API assertions, per-card rendered state checks and a prohibited
positive host-claim gate. The UI now consumes registry capability facts rather
than maintaining an unbound display copy. Expiry integration waits use the
server lease deadline, while the production TTL is unchanged.

The binding release decision remains: `capabilityProfiles` may be `real` only
for the signed reporting and server-admission control planes. Every report is
still `hostReported`; Execution, Sandbox and Streaming are `roadmap`.

The final Opus delta returned `PASS`, zero P0/P1. Before commit, Codex also
absorbed its non-blocking P2s by broadening the overclaim vocabulary gate and
adding a pure server-fact-to-card-state test. Full regression, Drizzle
no-drift, production audit and 1440/390 browser evidence are green. B3.7 and
S6.B3 are released; B4 is the next batch.
