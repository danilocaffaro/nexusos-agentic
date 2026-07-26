# S5.B2 QA discovery

## Scope

This gate covers organization-scoped content-addressed D1 payload reuse,
governed logical erasure, authority/separation of duties, semantic
idempotency, concurrency fencing and the end-to-end Outputs → Governance flow.

## Primary risks

1. A requesting human approves their own consequential effect while a peer is
   eligible.
2. A member or cross-tenant principal can inspect, propose, approve or execute
   erasure.
3. Deduplication reuses a hash collision or correlates content across tenants.
4. The affected reference count changes after approval but content is still
   cleared.
5. Concurrent execution clears twice, produces duplicate receipts or reports
   two winners.
6. Expired/failed attempts permanently block retry or a retry reports a
   terminal intent as successful.
7. Same-millisecond terminal races duplicate ledger events.
8. UI copy implies physical deletion, external dependency or stronger
   separation of duties than the system enforces.

## Architecture decision

Fable selected tenant-scoped best-effort deduplication and erasure by
`(organization, contentHash)`, with the human requester as proposer. Policy is
frozen at proposal, while the solo-owner exception is rechecked atomically at
approval commit. Opus validated closure of the prior P0/P1 findings and drove
additional fencing, retry and one-shot ledger guards.
