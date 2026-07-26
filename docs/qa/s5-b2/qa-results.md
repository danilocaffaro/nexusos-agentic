# S5.B2 QA results

> Status: PASS
> Date: 2026-07-26

## Automated evidence

- TypeScript: pass.
- Unit tests: 68 pass, including solo-owner domain/UI honesty guards.
- Migration tests: 3 pass, including the partial live-idempotency index and
  additive policy columns.
- Governance, presence, realtime and artifact integrations: pass.
- Artifact integration covers exact reuse, tenant isolation, hash collision,
  owner/admin authority, requester/peer separation, solo-owner commit guard,
  stale refcount, parameter tamper, terminal supersession and concurrent
  failure/success races.
- Production build and rendered HTML smoke: pass.
- ESLint and diff whitespace validation: pass.
- Production dependency audit: 0 vulnerabilities.

## Browser evidence

- Created artifact `d50d766e-0581-4a33-9e31-2412ad4d0f73` from
  `WI-A11CE001`; server hash
  `923dd8c2715b08092cf2aedc6039147d8127546332e9f52915559fe19a98c577`.
- Impact review showed one affected version and one live payload.
- Proposed intent `3417e8a3-d838-4c2e-ab58-ae46ef7cce44`; UI required typed
  `ERASE` and disclosed the commit-time peer recheck.
- Approval produced exactly one `intent.approved`; execution produced exactly
  one `effect.started` and one `effect.succeeded` with fencing token
  `2962827805316196`.
- Governance chain remained verified through sequence 120.
- Returning to Outputs showed “Payload apagado por política governada” and
  disabled a second erasure request.

## Residuals

- Erasure is logical unavailability, not cryptographic shredding of backups.
- D1 is the current payload driver. Filesystem/R2 drivers are optional scale
  work behind the same port.
- Blast radii above 100 immutable versions fail closed pending a paginated,
  separately reviewed bulk-erasure workflow.
- Hosted identity and step-up authentication remain required before the
  solo-owner exception can be described as production-grade assurance.
