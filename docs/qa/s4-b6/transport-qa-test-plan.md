# S4.B6 transport QA test plan

## Contract and unit gates

- Exact public wire key sets; no organization, recipient or message payload.
- Runtime validation for domain signals and private delivery envelopes.
- Recipient deduplication, chunking and byte-bound consistency.
- Fail-safe flag and binding selection.
- Wrangler/Vite Durable Object configuration parity.
- Same-origin browser policy with native-client support.
- Adapter delivery, resolver failure and hub failure behavior.

## Integration gates

- Owner and active peer can upgrade into the same room.
- Nonmember and cross-tenant subscription attempts fail closed.
- A committed message emits the exact conversation invalidation to both active
  members.
- The message body never appears in the frame.
- Removing the peer leaves its socket open but excludes it from every later
  publication through a fresh D1 recipient read.
- The removed peer can no longer fetch the conversation.

`vinext dev` can reset a rejected upgrade instead of forwarding the Worker's
404. A reset counts as a local proxy denial only when the health endpoint still
returns 200 and the paired authorized HTTP read returns 404.

## Regression gates

- TypeScript.
- Unit tests.
- D1 migration tests.
- Governance, presence and realtime integrations.
- Production build and rendered HTML smoke test.
- ESLint.
- Production dependency audit.
- Full suite with `NEXUS_REALTIME_PUSH=off`; the dedicated realtime integration
  explicitly enables push for its isolated transport proof.
