# S4.B4 QA Results

Date: 2026-07-25

## Automated evidence

- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run test:unit`: pass, 29/29.
- `npm run test:migrations`: pass, 3/3.
- `npm run test:integration`: pass against a new temporary D1 database.
- `npm run build`: pass.
- `npm run test:smoke`: pass.
- `npm run audit:prod`: pass, zero reported vulnerabilities.

The integration gate includes CAS error-code separation, owner/admin fan-out,
cross-tenant isolation, exact focus beyond 20 intents and no target promotion.

## Browser evidence

Passed at `http://127.0.0.1:3001/`:

1. Proposed a real local ActionIntent.
2. Observed the real sidebar count and a new Inbox item.
3. Selected the item; it transitioned to `seen` while the intent remained
   `proposed`.
4. Opened the exact linked intent in the Decision Ledger.
5. Approved as human; the item and badge disappeared.
6. Proposed from a previously focused ledger; focus moved to the new intent.
7. Repeated selection at 800x900; the stacked detail panel received focus and
   scrolled into view.
8. Confirmed the empty state after resolving test attention.

## Result

Critical scenarios: 20/20 passed.

