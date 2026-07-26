# S5.B5 QA results

## Outcome

Automated, adversarial and browser acceptance passed on 2026-07-26. The Opus
delta review returned `PASS` with zero P0/P1 after all three blocking findings
from its first implementation review were closed.

## Automated evidence

- TypeScript, ESLint and 91 unit tests passed.
- All 16 migrations apply exactly; all three migration tests passed.
- Governance, presence, realtime and artifacts API integrations passed.
- Production build and rendered-HTML smoke passed.
- Production dependency audit found zero vulnerabilities at the configured
  high-severity gate.
- Drizzle schema generation reported no schema changes and `git diff --check`
  passed.
- Domain tests prove exact-byte determinism, external SHA-256/base64 parity,
  canonical JSON, dynamic Markdown fences, Unicode control escaping, erased,
  failed and size-omitted bodies, graph inconsistency, the 50-row critical
  bound, advisory deduplication and newest-300 ledger ordering.
- A static SQL regression oracle prevents `scoped.*` from carrying raw bodies
  across the D1 result boundary and requires distinct evidence version/artifact
  windows plus tenant and erasure predicates.

## API and authorization evidence

The artifacts integration proves:

- JSON preview and Markdown produce the same SHA-256 and byte size;
- `Repr-Digest`, strong ETag, attachment filename, content type,
  `private, no-store`, identity `Vary` and `nosniff` are present;
- a repeated snapshot is byte-stable and an unrelated intent/ledger event does
  not change its representation hash;
- a real new supersession for an evidenced artifact changes the hash and makes
  the old expected hash return `409 package_changed`;
- malformed format/hash, undecided intent, non-member and cross-tenant calls
  fail closed;
- member, viewer, invited/suspended membership, disabled/archived human and
  agent/automation/policy/runner identities cannot bulk export;
- four concurrent downloads succeed while repeated/concurrent reads append no
  governance ledger entry;
- logically erased bodies never appear in Markdown, while their exact pins,
  reviews, lineage and erasure disclosures remain;
- review/supersession facts shared by duplicate evidence rows are rendered
  once, and every included ledger entry hash recomputes as valid.

Operational-log unit tests assert the route passes metadata only and never
parameters, artifact bodies or rendered bytes.

## Browser evidence

Against the local D1-backed application at `http://localhost:3001`:

- selected real intent `ae07d712-d872-4cd2-a756-8869836b92ce` in Decision
  Ledger and observed two evidence rows, three version-pinned reviews, 10/10
  relevant ledger references and the full exact-byte hash;
- opened literal Markdown only after client-side SHA-256 verification and
  confirmed the title, Sprint-6 outcome reservation, supersession coverage and
  incomplete-ledger non-claims;
- downloaded
  `decision-package-ae07d712-d872-4cd2-a756-8869836b92ce-bbdee4388d466818.md`;
  local SHA-256 recomputation matched the UI value
  `bbdee4388d46681858769b22869439127d33d1db0554d314f792f49d47a12765`;
- at 390 × 844 the document had no horizontal page overflow, metrics collapsed
  to two columns, actions stacked, the full hash wrapped and only the literal
  preformatted block scrolled internally;
- copy, literal-preview and verified-download controls are semantic, enabled,
  keyboard-focusable buttons.

The browser log contained only stale development HMR errors from hours before
this acceptance run; the current route and interactions produced no new error.

## Residual, non-blocking hardening

- Edge-deployment validation must prove an upstream CDN never converts the
  intentionally fresh private download to `304`.
- Distributed rate limiting, durable access-log retention, redaction profiles,
  detached signatures and externally published packages remain explicit
  pre-GA or later-sprint work.
- Filesystem/R2 payload storage remains an optional scale adapter, not a core
  dependency.
