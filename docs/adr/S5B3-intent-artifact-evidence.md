# S5.B3 — Artifact-version evidence for governed decisions

## Status

Accepted on 2026-07-26.

## Context

Immutable artifacts and governed payload erasure exist, but a decision cannot
yet cite the exact version that informed it. Copying Markdown into an intent,
attention item, conversation or ledger would create divergent records and make
retention ineffective. A generic polymorphic evidence table would also forfeit
foreign-key enforcement before a second evidence producer exists.

## Decision

NexusOS uses a specialized `intent_artifact_evidence` relation. A `basis` link
is attached by an active owner, admin or member while the intent is `draft` or
`proposed`. An `outcome` link is reserved for a non-human execution principal
while an intent is `executing`; no human HTTP route can create it in this
batch.

Every link pins an exact artifact-version id, artifact id, content hash and
byte size. Database triggers prove organization, project, version, payload and
principal coherence at insertion. Basis content must still be available when
linked, so a reviewer never receives an already-erased body as new decision
input. Subsequent governed erasure preserves the link, hash, size, producer and
work-item lineage.

The active basis set is frozen when the intent leaves `proposed`. Before then,
the original attacher or an owner/admin may supersede a link. Supersession is a
single constrained state transition; arbitrary updates and deletes are
rejected. A partial unique index permits a superseded version to be linked
again while preventing duplicate active links.

`evidence.linked` and `evidence.superseded` are appended to the hash chain in
the same D1 batch as their state change. Their canonical payload contains only
ids, version number, hash, byte size, relation, status and supersession time.
It contains no title, note, Markdown or conversation text. A one-shot
`(organization, payloadRef, kind)` guard and ledger sequence uniqueness protect
same-millisecond concurrency. The guard is trigger-enforced so an unmatched or
duplicate ledger insert aborts the entire evidence mutation, and its lookup is
covered by a bounded index.

The Decision Ledger exposes the real evidence set, a project-scoped immutable
version picker, supersession while open, frozen-state disclosure, payload
erasure state and a deep link back to Outputs. GitHub, Jira, R2 and the future
runner are not dependencies.

## Consequences

- A decision can name exactly what informed it without duplicating erasable
  content.
- Tenant, project, authority and phase boundaries are database invariants.
- The ledger remains verifiable after payload erasure.
- Evidence is typed today; a read-side union can combine GitHub or deployment
  evidence after those real producers exist.
- Free-text evidence annotations and human-created outcome evidence remain
  intentionally unavailable.

## Rejected alternatives

- Generic `source_kind/target_kind` links: no real foreign keys and premature
  polymorphism.
- Copying Markdown into governance: breaks retention and creates competing
  sources of truth.
- Removing evidence after approval: rewrites the historical decision basis.
- Mandatory GitHub/Jira evidence: violates the provider-independent core.
- Adding run ids now: anticipates Sprint 6 before its lease and fencing model.
