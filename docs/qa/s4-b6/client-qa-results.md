# S4.B6 client QA results

> Status: PASS
> Date: 2026-07-26

## Automated evidence

- TypeScript: pass.
- Unit tests: 58 pass.
- Governance, presence and realtime integrations: pass.
- Realtime test includes message, attention, presence, suppression, background
  conversation fanout, tenant/member denial and post-revocation denial.
- Production build and rendered HTML smoke: pass.
- ESLint: pass.
- Production audit: 0 vulnerabilities.

## Browser evidence

- Header state: `Realtime live`.
- External POST created message sequence 4.
- The exact message appeared in the selected browser timeline within the
  two-second assertion window.
- Health endpoint returned `200` with D1 ready.
- Existing console entries predated the server restart; no new application
  error appeared during the proof.

## Residuals

- Workspace-membership socket closure remains follow-up hygiene for the future
  membership-admin mutation path. Conversation revocation already fails closed
  through fresh D1 recipient resolution on every publication.
- Read-triggered attention expiry deliberately relies on the watchdog; emitting
  from that read would create a refresh/publication loop.
- Ping/pong keepalive has unit-level contract coverage; a dedicated network
  keepalive assertion remains non-blocking follow-up coverage.
- Video/audio meeting capability remains roadmap and does not affect presence.
