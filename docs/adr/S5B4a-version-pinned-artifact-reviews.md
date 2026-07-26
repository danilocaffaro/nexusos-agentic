# S5.B4a — Version-pinned artifact reviews

## Status

Accepted on 2026-07-26.

## Context

NexusOS can register immutable outputs and attach an exact version as decision
evidence, but a teammate cannot yet record whether that output is ready or
needs rework. A review must not mutate the artifact, become an implicit
approval for an external effect, or retain permanent free text that governed
payload erasure cannot remove.

The producer also cannot ordinarily certify their own output when an
independent human reviewer is available. A strict ban would, however, make a
true single-owner local workspace unusable.

## Decision

`artifact_reviews` is a specialized, append-preserving relation bound to one
exact `artifact_versions` row. Each review pins artifact id, version id, version
number, SHA-256 and byte size. It contains a bounded verdict and reason code:

- `approved`: `accurate` or `complete`;
- `changes_requested`: `needs_correction`, `needs_evidence` or `outdated`.

There is no comment or rationale field. Reviews are advisory: they do not
change `artifacts.current_version`, execute an effect or create an
`ActionIntent`.

An active human owner, admin or member can record one active opinion per
version. Re-review replaces that reviewer's active opinion through one
transaction. The client supplies the exact active review id it observed;
compare-and-swap makes two changed opinions deterministic, with one winner and
one `409 review_conflict`. The old row moves only from `active` to
`superseded`, a new row points to it, and both state transitions receive
metadata-only ledger events. Neither row can be deleted or otherwise edited.

The version producer may always request changes to their own work. They may
approve it only when they are the sole active eligible human owner and send an
explicit `solo_owner_ack`. The D1 insertion trigger rechecks the owner role and
absence of another active owner, admin or member at commit time. If a peer
appears after the application precheck, the transaction aborts.

New reviews require the exact payload to remain live and readable. Before a
write, the storage adapter recomputes UTF-8 byte length and SHA-256; corrupt
content fails closed rather than receiving an opinion. Governed erasure later
leaves the review, pinned hash, reviewer, history and ledger proof available,
while blocking a new opinion on content that can no longer be inspected.
An exact semantic retry returns the already-active review even after erasure;
it does not create a new opinion or ledger event.

`review.recorded` and `review.superseded` use canonical metadata envelopes with
no title, note, Markdown or display name. A trigger proves organization, row,
state, actor and timestamp for each event and prevents the same
`(organization, payloadRef, kind)` from being appended twice. The review change
and mandatory ledger inserts share one D1 batch; every statement must affect
exactly one row.

The Outputs surface renders the review next to the selected immutable version.
It discloses advisory semantics, bounded reasons, independent-review policy,
the single-owner exception, erased-payload behavior and prior superseded
opinions. It identifies the current user's active opinion and makes replacement
explicit.

## Consequences

- A reviewer can make a durable, machine-readable quality assessment without
  turning conversation into authority.
- A changed opinion preserves history instead of rewriting it.
- Review proof survives content retention without copying erasable text.
- Single-owner local use remains possible but visibly exceptional and
  commit-time guarded.
- Different reviewers may legitimately disagree; aggregation or decision
  package policy belongs to a later batch.
- Cross-artifact supersession remains S5.B4b and does not overload a review
  row.

## Rejected alternatives

- GitHub pull-request reviews as the system of record: makes an optional
  connector a core dependency and excludes non-code outputs.
- Free-text review comments in the immutable row: creates unerasable personal
  or sensitive content.
- Producer self-approval whenever acknowledged: acknowledgement cannot replace
  separation of duties when a peer exists.
- Updating one mutable review row: destroys the exact history and ledger
  correspondence.
- `ActionIntent` for review: an advisory, reversible opinion is not an external
  or consequential effect.
- A generic polymorphic review table: sacrifices exact foreign keys before a
  second reviewed resource exists.
