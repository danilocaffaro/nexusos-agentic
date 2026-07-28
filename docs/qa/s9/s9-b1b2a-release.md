# S9.B1b.2a release evidence — workflow-run snapshot integrity

## Candidate

S9.B1b.2a is a dark structural-projection candidate. Its exact six-path
allowlist is:

- `src/contracts/workflow-run.ts`
- `src/domain/workflows/workflow-run-snapshot.ts`
- `tests/unit/workflow-run-snapshot.test.ts`
- `tests/unit/workflow-run-initialize.test.ts`
- `docs/adr/S9B1b2a-workflow-run-snapshot-integrity.md`
- `docs/qa/s9/s9-b1b2a-release.md`

Claude Fable 5 session `c0445304-ff3d-418d-ac16-bc31ebdc5c22` returned `GO`,
P0=0 and P1=0 for the challenged three-batch redesign and this first batch.
Event identity and transition reduction remain separately prohibited.

## Truth boundary

The projector establishes structural shape only. It does not establish
authenticity, authorization, freshness, provenance, idempotency, record
integrity, replay safety or execution. No event payload/hash, reducer,
persistence, schema/D1, route, UI, effect, scheduler, provider, secret,
package or program-plan state is added.

## Gates

Executed from the isolated S9.B1b.2a worktree:

- focused unit: 15/15 passed;
- full unit glob: 449/449 passed;
- TypeScript: passed;
- ESLint and Oxlint: passed;
- production build: passed;
- rendered smoke: 2/2 passed;
- production dependency audit at `high`: zero vulnerabilities;
- `git diff --check`: passed;
- production budget: 554 final lines versus 261 at the promoted base, a net
  delta of 293 under the 300-line ceiling;
- allowlist: exactly the six authorized paths.

No migration or standalone integration program was added because this batch
has no persistence or side-effect boundary.

## Review status

Final Claude Opus 5 review: pending.

## Rollback

Revert the S9.B1b.2a commits. No schema, script, deployment or external state
changes are involved.
