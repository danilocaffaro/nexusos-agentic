# S4.B6 client QA discovery

## Scope

This gate covers the browser socket manager and operational invalidations for
messages, conversation lists, attention and presence.

## Primary risks

1. A concurrent capability probe demoting a healthy live socket.
2. Reconnect state changes resetting polling backoff during an outage.
3. A signal arriving during an in-flight read being lost.
4. Hidden tabs performing reads or failing to flush dirty state on return.
5. A non-selected conversation remaining stale or leaking to a nonmember.
6. Heartbeats generating presence fanout without a visible projection change.
7. Notification failure changing an already-committed HTTP mutation outcome.

## Review inputs

- Fable client architecture review: `CONVERGE`, with keepalive, fallback and
  resync corrections incorporated.
- Opus 5 implementation review: initial `DIVERGE` on three P1 findings.
- Fable principal-fanout follow-up: `CONVERGE`; its scaling P1 was corrected by
  iterating only authorized `principal:<id>` socket tags.
