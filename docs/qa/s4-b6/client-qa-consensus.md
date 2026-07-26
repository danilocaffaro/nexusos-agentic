# S4.B6 client QA consensus

## Architecture

Fable accepted one general organization socket per browser session because D1,
not socket subscription state, authorizes every conversation publication.
Frames remain payload-free and a principal learns a conversation id only when
the publish-time D1 resolver confirms active membership.

## Implementation review

The initial Opus 5 review found three P1 issues:

- capability probes could race and demote a healthy socket;
- poll effects reset failure backoff on every transport status change;
- list invalidation was watchdog-only for non-selected conversations.

The client now serializes probes, reads transport status through stable refs
without remounting pollers, and keeps an always-running list subscriber. The
hub fans out through authorized principal tags, avoiding both stale background
lists and an organization-wide socket scan.

The final Opus 5 pass then found two additional P1 issues:

- an ordinary capability probe returned `426` before authentication and active
  workspace authorization;
- the browser tried to close invalid-frame sockets with reserved code `1008`.

The worker now authenticates and authorizes before advertising upgrade
capability, with owner/non-member integration coverage. Invalid frames now use
the browser-legal private close code `4001`, protected by a unit contract test.

## Decision

CONVERGE. Fable accepted the principal-tag architecture and the final Opus 5
re-review reported no remaining P0/P1 findings. The push-on network integration,
push-off regression, typecheck, 58 unit tests, build, smoke, lint and production
audit are green. D1 remains the sole source of truth and disabling realtime
preserves the complete product.
