# S5.B2 QA consensus

## Architecture

Fable converged on D1-first, organization-scoped content addressing and logical
erasure as a governed effect. The requester remains visible as the human
proposer. Multi-admin separation is strict; solo-owner acknowledgement is
disclosed and guarded again in the commit transaction.

## Implementation review

The first Opus review found a P0 synthetic-proposer separation bypass and P1
gaps in authorization and terminal idempotency. The implementation replaced
the synthetic actor, restricted consequential routes to active human
owner/admins, introduced partial live-idempotency uniqueness and terminal
supersession, recomputed parameter hashes and fenced conditional writes.

The focused authority re-review marked every prior P0/P1 closed and returned
PASS. Its three P2 observations were also absorbed: retry recovery accepts only
a raced live intent, simulator expiry is reconciled, and the solo-owner
exception now has a commit-time peer guard selected by Fable.

The final concurrency review found one same-millisecond duplicate-terminal-event
hole. Conditional ledger insertion now rejects an existing event with the same
tenant, intent and kind. Parallel expiry and stale-failure integration tests
prove exactly one terminal event; parallel erasure execution proves one winner,
one payload transition and one started/succeeded pair.

## Decision

CONVERGE. No known P0/P1/P2 remains in the S5.B2 scope. The provider-independent
core preserves immutable provenance while governing every logical erasure with
real authority, immutable parameters, blast-radius preconditions, fencing,
receipts and an append-only hash chain.
