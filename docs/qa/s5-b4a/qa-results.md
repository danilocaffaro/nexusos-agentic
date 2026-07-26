# S5.B4a QA results

> Status: PASS
> Date: 2026-07-26

## Automated evidence

- TypeScript: pass.
- Unit tests: 75 pass, including closed reason vocabularies,
  metadata-only envelopes and honest/version-scoped UI.
- Migration tests: 3 pass across 15 migrations. Review coverage includes exact
  live references, producer/peer/solo-owner authority, reason compatibility,
  agent/viewer rejection, erased payload, append-preserving re-review,
  immutable rows and forged/duplicate ledger-event rejection.
- Governance, presence, realtime and artifact integrations: pass. Artifact
  coverage includes strict input shape, independent-review
  enforcement, producer change request, peer approval, idempotent retry,
  deterministic two-writer CAS, tenant isolation, nonmember rejection, corrupt
  payload rejection, erasure survival, post-erasure retry and solo-owner commit
  policy.
- Production build, rendered HTML smoke and ESLint: pass.
- Diff whitespace validation: pass.
- Production dependency audit: 0 vulnerabilities.

## Browser evidence

- Opened artifact `a813c56d-3c2c-41e0-b442-76e353b6d60b`, version 4,
  pinned to `sha256:ac6138fa4152388b…`.
- The local workspace had one eligible owner. Approval required the visible
  `solo_owner_ack` checkbox and created review
  `01ae4029-a701-42fc-b46e-f22faa5aee37`.
- Re-review first changed the opinion to
  `changes_requested / needs_evidence`, producing
  `0fd675f5-3267-426a-8d07-aa5e0cd09b69`. After the CAS correction, the live
  browser explicitly showed `VOCÊ` and `Substituir minha revisão`; replacing
  it with `changes_requested / outdated` created active review
  `8a8c9c98-60f4-4a42-b023-0b54c113158f` and retained two prior opinions.
- A different, already-erased output displayed the retained hash and
  `PAYLOAD APAGADO`, with every review control disabled.
- The real ledger remained verified through sequence 130:
  `review.recorded` #126, `review.superseded` #127,
  `review.recorded` #128, `review.superseded` #129 and
  `review.recorded` #130.

## Residuals

- Reviews are advisory and intentionally do not compute an aggregate release
  gate in this batch.
- The UI lists all reviews for one version without pagination; organization
  size and abuse bounds will be added before hosted multi-tenant GA.
- Cross-artifact head supersession is S5.B4b.
