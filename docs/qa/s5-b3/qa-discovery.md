# S5.B3 QA discovery

## Scope

This gate covers exact artifact-version evidence attached to ActionIntents,
authority and phase rules, append-only supersession, ledger atomicity, erasure
survival, tenant/project isolation and the Decision Ledger surface.

## Primary risks

1. Markdown or other erasable content leaks into governance or ledger rows.
2. A cross-tenant or cross-project version is linked to an intent.
3. A viewer, inactive principal or human outcome route mints evidence.
4. Evidence changes after approval and rewrites the decision basis.
5. A forged hash or size makes an evidence row appear self-verifying.
6. Payload erasure removes lineage or invalidates the hash chain.
7. Concurrent link/supersede operations append duplicate ledger events.
8. A generic link abstraction silently loses foreign-key guarantees.
9. UI copy implies external GitHub/Jira evidence or a Sprint 6 runner.

## Architecture decision

Fable selected a specialized relation with `basis` and `outcome`, exact version
pinning, database-enforced phase gates and metadata-only ledger envelopes.
Human routes can create only `basis`; `outcome` is reserved for a later
execution transaction without adding a runner in this batch.
