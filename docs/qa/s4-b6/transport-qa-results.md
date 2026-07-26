# S4.B6 transport QA results

> Status: PASS
> Date: 2026-07-26

## Automated evidence

- TypeScript: pass.
- Unit tests: 52 pass.
- Migration tests: 3 pass.
- Governance API integration: pass.
- Presence API integration: pass.
- Realtime API integration: pass.
- Production build: pass.
- Rendered HTML smoke: pass.
- ESLint: pass.
- Production audit: 0 vulnerabilities.
- Push-off regression suite: pass.

## Realtime evidence

- Exact member frame:
  `{"kind":"conversation","conversationId":"conversation-local-team-room"}`.
- Owner and peer both received the frame.
- Nonmember and cross-tenant subscriptions did not upgrade.
- After peer removal, the still-open peer socket received no later frame.
- The removed peer's authorized HTTP read returned 404.
- A 501-recipient unit proof produced bounded chunks of 500 and 1.

## Residuals

- A payload-free signal whose recipient read completes immediately before a
  concurrent revocation commits can still be in flight.
- Attention and presence signal paths are structurally implemented but are not
  counted as operationally proven until their mutation call sites land.
- The browser client and polling watchdog remain the next batch.
