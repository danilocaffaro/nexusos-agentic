# S4.B4 QA Discovery — Governed Attention

## Scope

One persistent, tenant-safe attention projection for approval-required
`ActionIntent`s, including database lifecycle, API, badge, Inbox UI and exact
navigation to governance.

## Critical invariants

- Proposal and attention delivery are one transaction.
- Every active human owner/admin receives one item; a plain member receives
  none and zero eligible addressees blocks proposal.
- Attention is scoped by organization and principal.
- `open -> seen` is the only user-driven transition and uses CAS.
- Reading or acknowledging attention never changes an intent or approval.
- A completed decision resolves every addressee copy atomically.
- Inactive or expired intents leave the active projection while immutable
  attention history remains.
- A deep-link target is exact, including beyond the ordinary 20-intent window;
  a miss never falls back.
- Lists are cursor-bounded and the global badge uses a read-only count query.
- Errors, stale data, tablet stacking and assistive-technology state are
  visible and honest.

## Risk areas

- Cross-tenant identifier probing.
- Duplicate/idempotent proposal delivery.
- Concurrent seen/approve operations.
- Expiry and future reject/cancel transitions.
- Cursor refresh after loading deeper pages.
- React Strict Mode focus ownership.
- Responsive focus/scroll at the 900px stacking breakpoint.

