# S5.B3 QA results

> Status: PASS
> Date: 2026-07-26

## Automated evidence

- TypeScript: pass.
- Unit tests: 72 pass, including metadata-only canonical envelopes and honest
  Decision Ledger copy.
- Migration tests: 3 pass across 14 migrations. Evidence coverage includes
  exact references, live payload, contributor/non-human authority, phase
  inversion, cross-tenant/project rejection, partial active uniqueness,
  immutable supersession, forged and duplicate ledger-event rejection.
- Governance, presence, realtime and artifact integrations: pass.
- Artifact integration covers basis attach, invalid human outcome, duplicate
  active link, two-way supersession race, freeze after approval, governed
  payload erasure, preserved metadata and verified chain.
- Production build and rendered HTML smoke: pass.
- ESLint and diff whitespace validation: pass.
- Production dependency audit: 0 vulnerabilities.

## Browser evidence

- Proposed ActionIntent `ae07d712-d872…`; chain verified at sequence 121.
- Linked artifact “S5.B1 · Registro de artifacts versionados” v4 with
  `sha256:ac6138fa4152388b…`; sequence 122 was `evidence.linked`.
- Superseded the link; sequence 123 was `evidence.superseded`. The old row
  remained visible and muted.
- Re-linked the same immutable version; sequence 124 was a second
  `evidence.linked`, proving partial-active uniqueness and retained history.
- Human approval produced sequence 125 and changed the evidence surface to
  `Frozen at decision`; picker and supersession action disappeared.
- The evidence deep link opened the exact artifact in Outputs with v1–v4
  history, current hash and literal content. No Markdown was rendered inside
  the governance evidence row.

## Residuals

- The picker exposes the 100 newest project versions and discloses when the
  bounded result is truncated; search/pagination is future work.
- Outcome evidence is enforced and migration-tested but has no human route.
  Its first real writer belongs to the Sprint 6 execution transaction.
- Logical erasure preserves proof but is not cryptographic shredding.
