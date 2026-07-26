# S4.B6 transport QA discovery

## Scope

This gate covers the server-side realtime transport only:

- payload-free invalidation contracts;
- authenticated WebSocket upgrade at the Worker boundary;
- one hibernating Durable Object hub per organization;
- publish-time D1 recipient authorization;
- post-commit message invalidation;
- noop/polling fallback.

The browser socket manager, watchdog policy, attention publication and presence
publication remain later S4.B6 batches.

## Primary risks

1. Client headers reaching the trusted hub boundary.
2. Cross-tenant hub selection or envelope misrouting.
3. Revoked sockets continuing to receive conversation activity metadata.
4. Notification failure changing an already-committed request result.
5. Wrangler and Vite Durable Object configuration drifting.
6. Free-plan limits being exceeded by large fanout envelopes.
7. Hibernation relying on in-memory state.

## Review inputs

- Fable architecture review: `CONVERGE`.
- Fable revocation follow-up: `CONVERGE` on D1 recipient resolution at publish
  time.
- Opus 5 implementation review: `CONVERGE`, no P0 or P1.
