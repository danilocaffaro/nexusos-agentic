# S5.B1 QA results

> Status: PASS
> Date: 2026-07-26

## Automated evidence

- TypeScript: pass.
- Unit tests: 64 pass, including request-order and conflict-submit guards.
- Migration tests: 3 pass, including trigger-level negative cases.
- Artifact network integration: pass, including authorization, tenant
  isolation, simultaneous append, stale conflict and integrity failure.
- Governance, presence and realtime integrations: pass.
- Production build and rendered HTML smoke: pass.
- ESLint: pass.
- Diff whitespace validation: pass.
- Production dependency audit: 0 vulnerabilities.

## Browser evidence

- Created one real output linked to `WI-A11CE001`.
- Appended versions through v3 and observed current metadata, history and
  literal content refresh together.
- A second writer created v4 while the browser editor still expected v3; the
  browser rejected the stale append and reloaded history without overwriting v4.
- Work Graph opened Outputs with the exact work item selected.
- An exact `?artifact=<id>` URL restored the output, its work item and all four
  versions after direct navigation.
- Header remained `Realtime live`; artifact correctness did not depend on push.
- At 390x844, document width equaled viewport width and the real output label
  remained visible.

## Residuals

- S5.B1 stores payload text in D1. Content-addressed deduplication and the
  filesystem/R2 adapter are the next planned batch.
- Payload erasure is structurally permitted by the database but has no direct
  route. Its execution must be introduced as a governed `ActionIntent`.
- This batch links artifact to work-item lineage; run, decision and release
  evidence links remain later Sprint 5 batches.
- Conflict recovery preserves the stale draft on screen and blocks submission,
  but side-by-side merge assistance remains part of the later output-review
  batch.
