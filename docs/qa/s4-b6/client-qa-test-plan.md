# S4.B6 client QA test plan

## Contract and unit gates

- `"pong"` is keepalive, not a domain frame.
- Exact payload-free shapes for conversation, attention and presence.
- Unknown fields, tenant routing and invalid ids fail closed.
- Full polling cadence outside `LIVE`; bounded watchdog cadence inside it.
- Full-jitter reconnect bounds and per-key burst coalescing.
- Presence live watchdog remains 15 seconds.

## Network integration gates

- Message, attention creation/seen/resolution and observable presence changes
  publish exact invalidations after commit.
- TTL-only presence heartbeat publishes nothing.
- A socket receives a non-selected conversation invalidation only when its
  principal is an active member of that exact conversation.
- A nonmember receives no such frame.
- A removed member's still-open socket receives no later conversation frame.

## Browser gates

- The header reaches `Realtime live`.
- An externally posted message appears in the open timeline within two seconds,
  below the polling baseline.
- The rendered log remains authoritative HTTP data rather than frame payload.
- No new application console error appears during the proof.

## Regression gates

- TypeScript, unit, migrations and all integrations.
- Production build and rendered HTML smoke.
- ESLint and production dependency audit.
- Full suite with push forced off.
