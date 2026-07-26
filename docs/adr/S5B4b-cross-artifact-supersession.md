# S5.B4b — Cross-artifact supersession

## Status

Accepted on 2026-07-26 after Fable/Opus consensus.

## Context

NexusOS preserves every artifact identity and immutable version, but cannot yet
state that one output should replace another in day-to-day navigation. The
relation must remain provider-independent, survive payload retention and avoid
rewriting review or decision evidence.

The registry deduplicates payloads by organization and content hash. Erasure
therefore affects every matching live payload, not one logical artifact. A
supersession also competes for the organization-wide ledger head with every
other governed write.

## Decision

`artifact_supersessions` is a typed, retractable, metadata-only relation from a
source artifact (the older/superseded output) to a target artifact (the
replacement). It is advisory and internal: it does not hide content, mutate
`artifacts.current_version` or `updated_at`, execute an effect, or require an
`ActionIntent`.

The graph node is the stable artifact id. Exact source and target head versions,
hashes and byte sizes are pinned as evidence of what the governor compared;
they do not create version-level graph nodes. One active outbound relation is
allowed per source artifact, while multiple sources may point to one target.
Chains are allowed and cycles are rejected by an organization-scoped recursive
walk over active artifact-id edges. Reaching the depth bound of 100 aborts
fail-closed rather than certifying an incomplete walk.

The client submits the source and target head numbers it observed. The server
resolves all other pin fields, recomputes the target payload byte count and
SHA-256, and the insertion trigger re-proves both heads at commit time. The
source payload may already be erased, but the target must be live and verified.
Source and target with the same content hash are rejected as a vacuous
replacement and because organization-scoped payload erasure cannot distinguish
their content.

Only an active human owner or admin may declare or retract the relation. This
is intentionally stricter than an advisory review: supersession changes the
registry's recommended navigation path for every member. Any current owner or
admin may retract a relation, including after the declarer is demoted. A
retraction changes only `active -> retracted`, records a closed reason, and
preserves the row forever. Changing the target is explicitly retract then
declare; there is no atomic replacement operation.

Retraction is not described as universally reversible. Redeclaration remains
possible only while the chosen target payload is live and still satisfies the
declaration rules. Exact semantic retries of declaration or retraction return
the existing state without another ledger event.

Declaration and retraction append `supersession.declared` and
`supersession.retracted` metadata-only events in the same D1 batch. Trigger
validation proves row, organization, state, actor and timestamp, and rejects a
duplicate event for the same relation and kind. Ledger-sequence contention is
reported distinctly from relation conflict so a client can retry honestly.

Supersession never changes an existing `artifact_reviews` or
`intent_artifact_evidence` row. A frozen decision remains based on the exact
version originally attached even if its artifact is later superseded. Existing
relations survive payload erasure and render endpoint availability truthfully.

Cross-project relations are allowed within one organization because artifact
reads are currently organization-wide. The read model discloses project and
archived state. Future project-scoped ACLs must re-authorize every endpoint and
candidate before disclosure.

## Closed vocabularies

Declaration reasons:

- `replaced_by_revision`;
- `duplicate_output`;
- `scope_moved`.

Retraction reasons:

- `declared_in_error`;
- `no_longer_accurate`.

No free-text field enters the row or ledger.

## API and read model

`GET /api/artifacts/:artifactId/supersession` returns the active outbound
relation, active inbound relations, retracted history, a bounded forward chain,
endpoint staleness/availability, governance capability and at most 100
organization candidates plus `candidatesTruncated`.

`POST /api/artifacts/:artifactId/supersession` accepts only
`targetArtifactId`, `sourceVersionNumber`, `targetVersionNumber` and
`reasonCode`.

`POST /api/artifacts/:artifactId/supersession/:relationId/retract` accepts only
`expectedRelationId` and `retractionReasonCode`.

## Consequences

- Every replacement is navigable and auditable without deleting the old output.
- Later artifact versions make the original pins visibly stale but do not
  silently rewrite or retract the relation.
- Global ledger serialization can cause a retryable conflict with an unrelated
  governed write; a shared serialized append primitive remains a later
  hardening item.
- Candidate/history pagination and project-level ACL enforcement are explicit
  pre-GA concerns.

## Rejected alternatives

- Mutating or archiving the source artifact: destroys the independent artifact
  lifecycle and obscures evidence.
- A version-level graph: permits an artifact-level cycle through different
  versions.
- GitHub replacement links as the system of record: makes an optional connector
  a core dependency and excludes non-code outputs.
- `ActionIntent`: the relation is retractable, metadata-only and has no external
  effect.
- Free-text rationale: creates permanent erasable-content ambiguity.

