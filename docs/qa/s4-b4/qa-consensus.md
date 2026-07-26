# S4.B4 QA Consensus

Review pair: Codex implementation + Claude Code CLI using Claude Opus 5.

## Iteration history

1. First Opus review: `ITERATE`.
   - Found an unsafe fallback from an old deep-link target to the newest intent.
   - Found unresolved expiry, inconsistent addressee routing and missing CAS,
     pagination, stale-data, mobile and accessibility coverage.
2. Second Opus review: `ITERATE`.
   - Confirmed the first fixes, then found Strict Mode focus cleanup, cursor
     page loss, a 761–900px breakpoint mismatch and count-poll writes.
3. Third Opus review: `CONVERGE`.
   - Confirmed exact targeting, atomic resolution, owner/admin consistency,
     database invariants, cursor continuation, tablet behavior and read-only
     badge polling.
   - Reported only P3 hardening opportunities.
4. Post-convergence audit of the hardened final diff: `CONVERGE`.
   - Reconfirmed exact targeting, cursor order, tenant isolation, atomic fan-out
     resolution and success-before-refresh behavior.
   - Found no P0, P1 or P2 regression.

The material P3 opportunities were subsequently addressed: organization-wide
inactive reconciliation now probes before writing; stale deeper pages reset
when the server total shrinks; command success survives refresh failure; local
seed state converges; focus status/ordering are deterministic; selected-item
removal is announced; and the inert filter is no longer a focusable button.
All focused gates and browser checks passed again after these changes.

Remaining P3 items are recorded for later load/operability cleanup: revalidate
cursor-loaded pages rather than conservatively resetting them after a large
queue shrink; map a rare addressee-deactivation trigger race to a domain error;
move organization-wide inactive reconciliation to a bounded background sweep;
make the external persistent integration-test escape hatch self-cleaning; and
offer an explicit way to clear a ledger focus without leaving the view. None
can authorize a different intent, cross a tenant boundary or bypass CAS.

## Decision

`S4.B4` satisfies its exit criteria. Presence, realtime transport and evidence
linkage remain explicitly separate batches.
