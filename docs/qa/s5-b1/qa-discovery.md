# S5.B1 QA discovery

## Scope

This gate covers the first real artifact/output registry: Markdown creation from
a work item, immutable version append, history/content reads, deep linking and
the Outputs workspace.

## Primary risks

1. A stale writer silently overwriting newer evidence.
2. Artifact, project, work-item, producer or payload crossing tenant boundaries.
3. Version metadata claiming a hash or size that the body does not have.
4. Payload persistence succeeding without its version, or vice versa.
5. A deep link selecting an unrelated work item or leaking a prior selection.
6. A UI metric, output row or lineage claim being fixture data.
7. Cancelled work becoming unauditable even though its historical output is
   still valid.

## Architecture decision

Fable selected an immutable Markdown registry as the first Sprint 5 vertical
slice. It uses only D1 and NexusOS code, keeps payload storage behind a port and
does not require GitHub, Jira, R2 or realtime. Content-addressed deduplication
and governed erasure are deliberately the next small batch.
