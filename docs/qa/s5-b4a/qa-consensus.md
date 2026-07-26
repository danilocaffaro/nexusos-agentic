# S5.B4a QA consensus

> Status: PASS
> Date: 2026-07-26

## Architecture consensus

Fable and Codex agreed that a review is a specialized advisory record pinned
to one immutable artifact version. It is not an approval of an external effect
and therefore does not require an `ActionIntent`. The durable row and ledger
envelope contain only bounded metadata; no free-text rationale enters the
permanent chain.

The frozen rules are:

- one active opinion per human contributor and exact version;
- append-preserving re-review with explicit compare-and-swap;
- producer change requests are allowed;
- producer approval requires either another eligible human or the
  commit-time-guarded `solo_owner_ack` exception;
- a new opinion requires live content whose bytes and SHA-256 are recomputed;
- governed erasure preserves existing reviews and exact semantic retries while
  blocking a changed blind opinion;
- review state and its mandatory metadata-only ledger events commit in one D1
  batch.

## Independent review history

The first Opus review returned `BLOCK` for two P1 findings:

1. a losing concurrent re-review could surface an unstable error;
2. commit-time trigger rules lacked direct negative coverage.

The implementation added observed-review CAS, deterministic `409
review_conflict`, conflict reload, a self-referencing history foreign key and
direct trigger tests for agent, viewer, forged version/hash, erased payload,
forged ledger reference/actor and duplicate events.

The second Opus review inspected the resulting worktree and returned `PASS`
with no P0 or P1. It confirmed that every losing race path rolls back the D1
batch, maps to 409 and leaves a valid contiguous ledger chain. It also
confirmed schema, migration, snapshot and journal consistency.

Four low-cost P2 improvements were then incorporated:

- malformed `expectedReviewId` is rejected before an idempotent early return;
- the agent trigger test now gives the agent a contributor membership and
  therefore proves the human-kind guard rather than a missing-membership guard;
- the immutable-review trigger has an explicit governed error mapping;
- conflict and stale-state refresh preserve the user's pending selection.

## Deferred, explicit residuals

- Review history is not paginated in the local-first batch. Bounded pagination
  is required before hosted multi-tenant GA.
- Ledger-head allocation follows the existing optimistic D1 pattern. A
  simultaneous unrelated ledger writer may receive a retryable conflict; a
  shared serialized append primitive belongs in the ledger hardening batch.
- Per-statement `meta.changes` checking is retained as a fail-closed invariant.
  The current fixed-shape batch cannot reach a post-commit false conflict; any
  future batch-shape change must re-evaluate this assumption.

## Release evidence

- Full gate: 75 unit tests, 3 migration tests, all governance/presence/realtime
  and artifact integrations, production build, rendered smoke, ESLint,
  production audit, schema generation and diff validation passed.
- Post-review directed gate: TypeScript, 75 unit tests, 3 migration tests,
  artifact integration, ESLint and diff validation passed.
- Browser QA recorded initial review, two preserved replacements, exact ledger
  events through sequence 130 and disabled controls for an erased payload.

The final Opus delta check inspected the four P2 fixes, found no new P0/P1 or
regression and returned `PASS`. A fresh full gate over that exact state also
passed. Fable, Codex and Opus therefore reached consensus that S5.B4a is ready
to commit.
