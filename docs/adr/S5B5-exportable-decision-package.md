# S5.B5 — Exportable Markdown decision package

## Status

Accepted on 2026-07-26 after Fable/Opus consensus.

## Context

Sprint 5 must close with a reviewer able to travel from an output to its
producer, immutable evidence and governed decision without requiring GitHub,
Jira, paid storage or a future runner. NexusOS already stores those facts in
D1, separates erasable payload bodies from durable metadata and verifies its
organization ledger.

An export must not create a second durable copy of erasable bodies, invent a
read-audit side effect or claim more cryptographic assurance than it proves.
It must also remain byte-deterministic so preview and download can use
optimistic compare-and-swap.

## Decision

The package root is one `ActionIntent`. It is eligible only after its status
leaves `draft` or `proposed`, because basis evidence freezes at that boundary.
`approved`, `rejected`, `expired`, `cancelled`, `executing`, `succeeded`,
`failed` and `interrupted` are truthful decision/lifecycle states and may be
exported as observed.

The package is a read-only projection generated on demand. NexusOS does not
persist it as an artifact, payload or package row and does not append a ledger
event for an export. Persisting rendered Markdown would duplicate erasable
content behind a second retention path; logging every download in the
governance chain would turn a read into a contended effect.

All source rows are read through one transactional D1 batch using
intent-scoped joins. The renderer is a pure, versioned function over that
snapshot. It emits UTF-8 Markdown with LF structure, fixed section order,
canonical JSON, deterministic row ordering and no request-time timestamp or
requester identity in the bytes.

`representationHash` is SHA-256 over the exact downloadable Markdown bytes.
`packageId` is the external identifier
`nexus:decision-package:v1:<intentId>:sha256:<64 lowercase hex>`. Neither value
is embedded inside the Markdown, which avoids a self-referential hash. The JSON
preview, `Repr-Digest`/ETag response metadata, download filename prefix and UI
expose the hash. An unchanged decision-scoped snapshot therefore produces
identical bytes, hash and id for every authorized caller.

The generated document includes:

1. format/spec version, capability and retention disclosures;
2. organization, project and full ActionIntent decision fields, including
   canonical parameters and their stored hash;
3. approvals and their parameter binding, separation-of-duties and solo-owner
   acknowledgement state;
4. active and superseded `basis` evidence metadata, with exact artifact
   version/hash/size, producer and work-item lineage;
5. literal content for active basis evidence while within the content budget,
   with per-evidence integrity state; superseded basis evidence remains
   metadata-only;
6. active and superseded reviews for evidenced versions;
7. active/retracted supersession metadata for evidenced artifacts, with
   pinned heads and staleness/availability disclosures;
8. outcome-evidence metadata when it exists, otherwise an explicit
   Sprint-6-reserved statement;
9. relevant typed ledger entries with each stored entry hash recomputed; and
10. deterministic verification instructions that name the exact hash
    algorithm and the facts not covered by a signature.

Conversation text, presence, attention, provider credentials, prompts, secrets
and run fields that do not yet exist are excluded. Parameters and artifact
content may still be sensitive operational data, so both preview and Markdown
state that exporting moves those bytes outside NexusOS retention controls.

Live content is byte-counted and rehashed before rendering. Each active basis
row receives `contentIntegrity` equal to `verified`, `failed`, `erased` or
`omitted_size_bound`. Only `verified` content is embedded. A failed body
renders a durable integrity warning with retained metadata rather than making
the rest of an otherwise truthful decision unavailable. A pin that disagrees
with immutable artifact-version metadata is a graph inconsistency and still
aborts the package.

Artifact bodies and canonical JSON use block fences longer than any backtick
run in the embedded text. Every other database string is treated as an
untrusted scalar: every Unicode control/format/line-separator character
(`Cc`, `Cf`, `Zl`, `Zp`, including DEL, C1, bidi and zero-width controls) is
converted to a visible `\u{HEX}` escape, literal backslashes remain
unambiguous, and the resulting quoted value is wrapped in a dynamically padded
inline code span. No title, name, ref, reason or status is interpolated as raw
Markdown.

Artifact bodies are reproduced verbatim for byte fidelity and remain untrusted
bytes even inside a safe dynamic fence; bidi or invisible characters may affect
their display inside that block. LF normalization applies only to
renderer-emitted package structure, never to embedded bodies.

Only entries directly related to the intent, its evidence, included reviews
and included supersession rows are rendered. The renderer recomputes the hash
of each included stored ledger envelope with a subset-safe
`recomputeLedgerEntryHash` helper; it does not call the contiguous
`verifyLedgerChain`. It also recomputes canonical `parametersJson` and requires
the result to match `parametersHash`. The package does not claim chain
continuity across omitted sequence gaps, external recomputability of payload
preimages, artifact-registration coverage or a digital signature. Full
organization chain verification remains the separate existing governance
operation; a failure elsewhere in the organization cannot mutate or brick an
otherwise unchanged decision package.
Markdown renders the recomputation outcome beside every included entry; JSON
and download therefore expose the same integrity state.

## Bounds

Completeness-critical graph data fails closed:

- more than 50 basis/outcome evidence rows, including superseded history:
  `package_bounds_exceeded`.

Advisory data is bounded and disclosed rather than blocking the decision:

- at most 20 reviews per evidenced version, newest first with stable id
  tie-break and a per-version truncation marker;
- at most 100 active/retracted supersession rows across evidenced artifacts,
  with a truncation marker;
- at most the newest 300 typed ledger entries related to the intent, included
  evidence rows and the exact windowed review/supersession rows above, rendered
  back in ascending sequence order. `ledgerEntriesTruncated`, total matching
  count and rendered count are visible in JSON and Markdown. Events for
  advisory rows omitted by their own window are not selected and that coverage
  limit is explicit.

The ledger bound limits D1 result size and hash CPU. Ledger entries are
supporting references rather than a complete chain proof, so disclosed
truncation is safer than permanently refusing an otherwise complete decision
because advisory history grew.

The renderer embeds at most 2 MiB of live active-basis bodies in deterministic
evidence order. Further live bodies render an explicit size-bound omission
with their pinned hash and byte size and are not represented as integrity
verified. This is omission of payload convenience, not of evidence identity or
lineage.

The static D1 batch contains only statements keyed by organization and intent.
Every dependent query uses intent-scoped joins/subqueries rather than ids from
a prior result. An aggregate/ordered-window CTE computes evidence count and
running UTF-8 bytes inside SQL with `length(CAST(body_text AS BLOB))`, never
character-count `length(TEXT)`; body text is returned only while the count is
at most 50 and the running embed total is at most 2 MiB. Metadata queries use
`LIMIT 51` for the fail-closed check. The export path uses the primary D1
binding, not a split read-replica session.

All live active-basis rows consume their actual stored UTF-8 body bytes in
deterministic evidence order before integrity classification. A corrupt body
or a second evidence row referencing the same payload therefore still consumes
budget; this can make a later valid row `omitted_size_bound`, and the document
discloses that deterministic accounting rather than silently repacking.

## Authorization

An active human owner or admin in the intent organization may preview or
download. Bulk composition includes canonical intent parameters and multiple
payloads, so it is intentionally stricter than individual artifact/governance
reads. Member, viewer, inactive, non-human, non-member and cross-organization
callers fail closed; concretely this includes membership `member`, `viewer`,
`invited` or `suspended`, principal `disabled` or `archived`, and every
non-human principal kind. Cross-organization ids use not-found behavior.
Approval rows, which have no organization column, are authorized only through
their join to the already-scoped intent. Export is not an `ActionIntent`.

Every preview/download emits a structured metadata-only operational access
record (`requestId`, organization, principal, intent, outcome, byte size and
package hash) through `DecisionPackageAccessLogPort`. It never enters the
governance ledger and never logs parameters or artifact content. The
open-source console adapter works without a paid service; log retention and
distributed rate-limiting remain an explicit pre-GA deployment responsibility.
Owner/admin restriction and the 2 MiB body cap are the current extraction
controls.

## API

`GET /api/governance/intents/:intentId/decision-package` returns JSON preview:

- eligibility and deterministic section summaries;
- exact Markdown byte size;
- full `representationHash` and `packageId`;
- included ledger-entry recomputation result and coverage disclosure;
- erased/omitted/truncated disclosures;
- no embedded Markdown body.

Preview executes the complete snapshot builder and exact Markdown renderer,
then discards the bytes after hashing. The returned hash is an assertion by the
server until the client downloads and recomputes the bytes; it is never derived
from section summaries.

`GET /api/governance/intents/:intentId/decision-package?format=markdown`
returns exact Markdown bytes as `text/markdown; charset=utf-8`,
`Content-Disposition: attachment`, `Repr-Digest: sha-256=:<base64>:`, a quoted
strong ETag, `Cache-Control: private, no-store` and `Vary` for the trusted
identity inputs: `Authorization, Cookie, X-Nexus-Test-Principal,
X-Nexus-Test-Organization`. Optional
`expectedRepresentationHash=<64 lowercase hex>`
provides preview-to-download CAS. A malformed value returns 400; a stale value
returns `409 package_changed` with the new `representationHash` and
`packageId`, so a client need not re-preview blindly. `If-None-Match`/304 is
not supported because cached bytes may have been erased since the prior read.
The route ignores `If-None-Match` and returns a freshly authorized 200 rather
than 304 or an error.

Both representations use one snapshot builder and renderer. JSON does not
reimplement document rules.

The domain adds byte-oriented SHA-256 helpers that return lowercase hex and
RFC-9530 base64 over the same `Uint8Array`; artifact string hashes keep their
existing helper. The strong ETag is a client fingerprint/CAS aid, not a cache
revalidation mechanism. `Vary` remains defense in depth for trusted identity
inputs even though `private, no-store` and no 304 disable reuse.

The Decision Ledger detail shows an export panel only for a selected intent.
It displays eligibility, full hash, byte size, ledger coverage limits and every
disclosure, and provides preview/download actions. Literal preview fetches the
Markdown representation separately and renders it as text, never executable
Markdown.

## Failure and concurrency semantics

- D1 batch snapshot prevents torn intent/evidence/review/supersession reads.
- Request-time identity and time never change package bytes.
- A review, retraction or other included decision-scoped fact after preview
  changes the hash; download CAS reports `package_changed`.
- An unrelated organization ledger event changes neither bytes nor package id,
  so CAS and ETag remain useful under concurrent operations.
- Export performs no writes, consumes no fencing token and creates no ledger
  contention.
- Graph inconsistency or exceeded evidence count fails closed. Per-body
  integrity failure and optional content/advisory omissions are explicit.

## Rejected alternatives

- Stored package artifact: duplicates erasable content and creates recursive
  package lineage.
- Artifact-rooted aggregate: has no decision freeze point and an unbounded
  inbound decision set.
- Hash embedded inside the bytes it hashes: self-referential and unverifiable.
- Generation timestamp inside Markdown: destroys byte determinism without
  adding trusted chronology.
- Organization ledger head inside Markdown: gives one frozen decision
  unrelated ids, CAS conflicts and cache misses as other work occurs.
- Relevant ledger subset called “anchored”: gaps do not prove continuity.
- Full genesis verification per export: grows without bound and can
  permanently brick export for an active organization.
- Ledger event per download: turns a read into a governance effect and grows
  the chain from traffic.
- PDF/HTML/ZIP, digital signatures and share links: useful later, not required
  to close Sprint 5.

## Deferred

Detached signatures, Git/external anchoring, a governed publish-package effect,
durable export-access retention, distributed rate limiting, field-level
redaction profiles, package persistence, PDF/HTML/ZIP, runner outcome receipts,
GitHub receipts and shareable links.
