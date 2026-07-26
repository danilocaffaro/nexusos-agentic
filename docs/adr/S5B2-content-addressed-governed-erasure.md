# S5.B2 — Content-addressed payloads and governed erasure

## Status

Accepted on 2026-07-26.

## Context

S5.B1 separated immutable artifact/version metadata from erasable Markdown
payloads, but stored every body independently and exposed no safe erasure
lifecycle. S5.B2 must reduce duplicate storage and make content unavailable
without weakening lineage, tenant boundaries or the ActionIntent authority
model. GitHub, Jira, R2 and paid services cannot be runtime requirements.

## Decision

The initial payload adapter remains D1-backed and performs best-effort,
organization-scoped reuse by SHA-256. Reuse succeeds only when byte size and
literal body also match. A collision signal fails closed. Races may leave more
than one exact payload row; correctness therefore treats `(organization,
contentHash)` as the erasure boundary and clears every live duplicate.

Erasure is logical unavailability. Immutable hash, size, version, producer and
lineage remain; body text becomes `NULL`. This is explicitly not cryptographic
shredding of replicas or backups.

There is no direct destructive route. An owner/admin first reviews the complete
tenant-scoped blast radius, supplies a reason and proposes
`nexus.artifact.erase_payload`. The intent freezes parameters and affected
versions, binds the observed refcount as a precondition, expires after 30
minutes and requires human approval. Execution recomputes the parameter hash,
rechecks refcount atomically, uses a random fencing token, clears payloads and
appends one started and one succeeded event in one D1 batch.

The human requester is the proposer. When two or more humans are eligible, the
requester cannot approve. A sole owner may self-approve only after an explicit
acknowledgement. The approval INSERT rechecks, in the same D1 transaction, that
no other active owner/admin human has appeared since proposal.

Semantic idempotency is unique only for live statuses. Expired, failed,
rejected, cancelled and interrupted attempts may be superseded. Succeeded
erasure attempts report already erased. Terminal ledger events are guarded by
tenant, intent and kind so same-millisecond races cannot duplicate them.

## Consequences

- NexusOS core remains free of proprietary storage or tracker dependencies.
- D1 duplicate cleanup remains correct even when staging races create exact
  duplicate rows.
- The ledger preserves why, who, blast radius, approval and execution while
  erasable content stays outside the chain.
- Solo-owner approval is a disclosed local exception, not a substitute for
  hosted step-up authentication.
- Physical/cryptographic deletion, retention of backups and external blob
  lifecycle policies remain later operational capabilities.

## Rejected alternatives

- A synthetic policy proposer: it hides the human requester and bypasses real
  separation of duties.
- Direct DELETE endpoints: they separate effect from approval, preconditions
  and audit receipts.
- Mandatory R2, GitHub or Jira storage: it violates the provider-independent
  core and is unnecessary for this bounded Markdown slice.
- Global hash deduplication: it creates cross-tenant correlation and erasure
  coupling.
