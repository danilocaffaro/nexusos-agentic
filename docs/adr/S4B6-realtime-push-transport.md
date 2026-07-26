# ADR S4.B6 — Realtime push transport

> Status: ACCEPTED
> Date: 2026-07-26
> Decision: payload-free invalidation over hibernating WebSockets, with D1
> cursor backfill and polling fallback

## Context

Messages already have a conversation-local monotonic sequence and
`afterSequence` backfill. Attention and presence already have bounded,
visibility-aware polling. Realtime must reduce steady-state polling without
becoming a new source of truth, authority channel or paid dependency.

The initial SSE proposal was reopened after checking the current platform
limits. Ordinary Workers on the Free plan can keep an HTTP response open
without a wall-time limit, but have 10 ms of cumulative CPU per invocation. A
long SSE request that repeatedly wakes to run JavaScript and D1 queries is
therefore unsafe on the Free baseline even though waiting itself is free.
Workers Standard has a larger CPU budget, but paid infrastructure cannot become
a functional requirement.

SQLite-backed Durable Objects are now available on Workers Free. Cloudflare
recommends the WebSocket Hibernation API for realtime workloads: sockets remain
connected while the object sleeps and idle duration is not billed.

Primary references:

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects on Free](https://developers.cloudflare.com/durable-objects/)
- [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Decision

Introduce a portable `RealtimeNotifyPort` and two adapters:

- `NoopRealtimeNotifyPort`, which preserves the complete polling product and is
  the off-Cloudflare and rollback path;
- a Cloudflare Durable Object adapter using one hibernating hub per
  organization.

The hub transports only payload-free invalidation signals:

- conversation changed, with an optional sequence hint;
- attention changed for one principal;
- presence roster changed;
- later, conversation detach for a revoked principal.

It never transports message text, intent parameters, presence details, model
context or authority. A client that receives a signal runs the existing
authorized HTTP read. D1 remains the sole source of truth.

Push publication is best effort and occurs only after the authoritative D1
write commits. Lost, duplicated or reordered signals are harmless:

- messages reconcile by `afterSequence`;
- attention and presence refetch their current projections;
- a retained watchdog poll repairs a missed notification;
- disabling push restores the current polling behavior.

The Durable Object is a fanout adapter, not an ordering authority. It owns no
message sequence, ledger event, approval or presence lease.

Fanout is scoped inside the organization as well as between organizations:

- a conversation signal is sent only to sockets for active members of that
  conversation;
- an attention signal is sent only to sockets authenticated as its target
  principal;
- a presence signal may reach organization members, but carries no roster
  contents.

Every `RealtimeNotifyPort` adapter absorbs validation, transport and delivery
failures. Publication can therefore never turn a committed authoritative write
into a failed request.

## Rejected alternatives

- Ordinary-Worker SSE: rejected because a D1 polling loop inside one long Free
  invocation can exceed the cumulative CPU budget and creates a Paid-only
  transport fork.
- Long polling: rejected because it still consumes reader-driven requests and
  offers no server-side change source.
- Polling only: retained as fallback, but rejected as the Sprint 4 endpoint
  because its cost grows with readers regardless of activity.

## Rollout

1. **Landed:** add the signal contract, port and noop adapter.
2. Add the hibernating hub and Free-compatible local binding.
3. Connect a single socket manager; keep polling as watchdog/fallback.
4. Publish detach on membership revocation and close the QA package.

The planned feature flag `NEXUS_REALTIME_PUSH=off` will select the noop adapter
and polling baseline when the composition root lands in step 2. No D1 schema
migration is required. A Wrangler Durable Object class migration is
infrastructure metadata, not application data.

## Sprint 4 exit acceptance

- Free-compatible local infrastructure delivers message, attention and
  presence invalidations without payload data.
- Suppressing all signals still converges through watchdog polling.
- Cross-tenant sockets never share a hub.
- Conversation invalidations reach only active conversation members.
- Attention invalidations reach only their target principal.
- Revoked members receive no further conversation invalidations and cannot
  fetch the conversation.
- Hibernation-safe state is reconstructible from tags and serialized socket
  attachments.
- Push-off mode passes the complete suite and remains fully functional.
