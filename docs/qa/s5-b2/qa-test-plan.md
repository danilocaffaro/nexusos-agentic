# S5.B2 QA test plan

## Domain and contract

- Reuse exact content only within one organization.
- Reject hash/size/body inconsistency and invalid erasure reasons.
- Bind approvals to parameter hash, expiry and separation-of-duties policy.
- Require an explicit solo-owner acknowledgement.
- Recompute parameters before execution.

## Persistence and API

- Prove exact reuse, cross-tenant isolation and race-tolerant duplicate rows.
- Return a complete raw reference count and reject scopes above 100 versions.
- Require owner/admin for impact, proposal, approval and execution.
- Block requester approval when a peer exists.
- Recheck the solo-owner exception inside the approval INSERT transaction.
- Fail stale blast radius without clearing content.
- Run concurrent stale failure, expiry and successful execution attempts; each
  terminal event kind appears once and successful execution has one winner.
- Allow a terminal attempt to be superseded while one live semantic attempt
  remains unique.
- Return already-erased after a succeeded attempt.
- Preserve hash, byte size and lineage while returning `content: null`.

## Browser

- Publish a real Markdown output.
- Review exact versions, live copies and content hash.
- Propose an erasure reason and navigate to the focused governance intent.
- In a solo-owner workspace, require typed `ERASE` before approval.
- Execute only after approval and observe the receipt plus verified chain.
- Return to Outputs and observe the payload-unavailable state with erasure
  action disabled.

## Regression

- TypeScript, unit, migrations and all integration suites.
- Production build and rendered HTML smoke.
- ESLint, diff whitespace and production dependency audit.
