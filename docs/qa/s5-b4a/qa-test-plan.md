# S5.B4a QA test plan

## Domain and contract

- Accept only the two verdicts and their compatible bounded reason codes.
- Produce canonical ledger envelopes without titles, notes, Markdown or names.
- Pin exact artifact, version, content hash and byte size.

## Persistence and API

- Apply all migrations to an empty database and apply S5.B4a to the local
  previous state.
- Reject invalid verdict/reason pairs, forged version metadata, corrupted
  payload bytes and erased payloads.
- Permit active human owners, admins and members; reject viewers, agents,
  inactive identities and nonmembers.
- Reject ordinary producer approval when an eligible peer exists.
- Permit producer change requests.
- Permit producer approval only with explicit `solo_owner_ack` and recheck the
  no-peer invariant in the insert trigger.
- Return an identical active review idempotently, including after a later
  payload erasure.
- Replace one reviewer's opinion with one new active row and one preserved
  superseded row.
- Race two different re-reviews and prove one winner, one active opinion and no
  partial ledger state.
- Return not-found across tenant boundaries.
- Erase the reviewed payload through governance, retain review metadata and
  reject a new changed opinion.
- Verify the organization ledger after all review events.

## Browser

- Open a real output and exact version in Outputs.
- Observe the version hash and advisory/no-free-text disclosure.
- Exercise the single-owner acknowledgement and record approval.
- Change the verdict and reason, submit a re-review and inspect retained
  history.
- Open Decision Ledger and verify `review.recorded`,
  `review.superseded`, `review.recorded` in sequence.
- Switch versions and prove the panel follows the selected version.

## Regression

- TypeScript, unit, migration and all integration suites.
- Production build and rendered HTML smoke.
- ESLint, diff whitespace and production dependency audit.
