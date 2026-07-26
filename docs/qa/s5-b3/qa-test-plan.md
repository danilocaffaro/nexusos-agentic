# S5.B3 QA test plan

## Domain and contract

- Accept only `basis` on human evidence routes.
- Produce deterministic canonical envelopes containing no title or content.
- Preserve exact version id, version number, hash and byte size.

## Persistence and API

- Apply the migration from an empty database.
- Prove same-tenant, same-project, exact-version and live-payload insertion.
- Reject forged hash/size, cross-reference, invalid phase and inactive actor.
- Allow owner/admin/member basis links; reserve outcome links for non-human
  execution principals.
- Reject arbitrary update and delete.
- Allow one pre-decision supersession and active relink.
- Freeze attach and supersession after approval.
- Race two supersession requests and prove one winner/one ledger event.
- Erase the referenced payload through the existing governed flow and prove
  metadata, deep lineage and the hash chain remain valid.
- Return not-found across tenant boundaries and never return payload content.

## Browser

- Open a proposed ActionIntent in the real Decision Ledger.
- Select and link a project-scoped immutable version.
- Observe hash, work-item lineage and an Outputs deep link.
- Approve the intent and observe `Frozen at decision`.
- For an erased basis, show the preserved proof and unavailable payload state.

## Regression

- TypeScript, unit, migration and all integration suites.
- Production build and rendered HTML smoke.
- ESLint, diff whitespace and production dependency audit.
