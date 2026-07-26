# S5.B5 QA test plan

## Domain and renderer

- Deterministic ordering, LF structure, canonical JSON and spec version.
- SHA-256 parity over exact response bytes; id/filename/ETag use that hash.
- Dynamic block/inline fences and control escaping resist embedded backticks,
  newlines, fake headings, fake hash text, bidi controls, C0/C1, DEL and
  zero-width format characters in every untrusted field.
- Erased, budget-omitted and advisory-truncated disclosures are stable.

## Repository and authorization

- Eligible status matrix and `draft`/`proposed` rejection.
- Active owner/admin allowed; member/viewer, invited/suspended membership,
  disabled/archived principal, every non-human kind, non-member and
  cross-organization callers denied without disclosure.
- Active/superseded evidence, producers, reviews and supersession metadata are
  tenant/version coherent and deterministically ordered.
- Corrupt payload is omitted with a durable integrity warning; graph
  inconsistency and critical bounds fail closed.
- Subset-safe relevant-entry hash recomputation and explicit incomplete-chain
  coverage; canonical parameters rehash to their stored decision hash.
- More than 300 matching events renders only the newest 300 in ascending order,
  with exact counts/truncation and no event for an omitted advisory row.

## API and concurrency

- JSON preview and Markdown derive the same byte hash.
- Exact content type, attachment filename, strong ETag, `Repr-Digest`,
  private/no-store cache policy and identity vary.
- `expectedRepresentationHash` succeeds after an unrelated ledger write and
  returns `package_changed` with the new hash after a relevant change.
- Repeated and concurrent exports write no D1 rows.
- Access logs contain metadata only and never parameters or content.
- `If-None-Match` is ignored and a fresh authorized 200 is returned.

## Browser

- Select an eligible real intent from Decision Ledger.
- Inspect lineage, erasure, integrity and ledger-coverage disclosures.
- Preview as literal text, copy full hash and download Markdown.
- Recompute downloaded bytes locally and match the UI hash.
- Exercise mobile layout and keyboard navigation.

## Regression

- TypeScript, unit, exact migrations and all integration suites.
- Production build, rendered HTML smoke, ESLint, whitespace, dependency audit
  and schema-generation consistency.
