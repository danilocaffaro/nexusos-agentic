# S5.B4b QA test plan

## Domain and contract

- Accept only the declaration and retraction reason vocabularies.
- Hash metadata-only envelopes with no title, Markdown, note or display name.
- Pin exact source and target heads while using artifact ids as graph nodes.

## Migration and persistence

- Apply all migrations to an empty database and S5.B4b after S5.B4a.
- Assert the partial unique active-source index and all four triggers.
- Reject self reference, equal hashes, forged pins, stale heads, unreadable
  target, ineligible actor, mutation, deletion and forged/duplicate ledger
  events through direct SQL.
- Prove direct and recursive cycles, including a different later source
  version, are rejected; prove a retracted edge no longer creates a cycle.
- Prove many sources may point to one target and depth exhaustion fails closed.

## API

- Declare, exact retry, conflicting second target and concurrent declaration.
- Reject stale observed source/target heads and cross-organization ids.
- Permit owner/admin; reject member, viewer, non-human and inactive writers.
- Permit erased source with live target; reject erased/corrupt/equal-hash
  target.
- Retract, exact retry, concurrent retry and redeclare after retraction.
- Distinguish ledger-head contention from supersession conflict.
- Verify the organization ledger after declare, retract and redeclare.
- Assert artifact versions/timestamps are unchanged and run review/decision
  evidence regressions.

## Browser

- Select a real source and organization-wide target candidate.
- Declare with a closed reason and inspect the source banner and target inbound
  relation.
- Advance a head and verify stale-pin disclosure.
- Retract with the warning that redeclaration requires a live target.
- Inspect retained history, erased endpoint truthfulness and bounded chain.

## Regression

- TypeScript, unit, exact migration list and all integration suites.
- Production build, rendered HTML smoke, ESLint, diff whitespace, production
  dependency audit and schema-generation consistency.
