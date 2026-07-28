# S9.B1a release evidence — versioned workflow definition

## Candidate

S9.B1a is a dark, additive candidate with no production consumer. The release
gate covers the exact five-path allowlist:

- `src/contracts/workflow-definition.ts`
- `src/domain/workflows/workflow-definition.ts`
- `tests/unit/workflow-definition.test.ts`
- `docs/adr/S9B1a-workflow-definition.md`
- `docs/qa/s9/s9-b1a-release.md`

Architecture council: Claude Fable session
`889046d4-c1a8-4a9b-99e8-1b95903039ce`; corrected verdict `GO`, P0=0, P1=0.

## Truth boundary

The only positive claim is `declared_only_not_schedulable`. There is no
storage, route, UI, effect, trigger, provider, scheduler, credential or runtime
consumer. Workflow capability remains `roadmap`.

## Gates

Executed from the isolated S9.B1a worktree:

- focused unit: 10/10 passed;
- full unit glob: 425/425 passed;
- TypeScript: passed;
- ESLint and Oxlint: passed;
- production build: passed;
- rendered smoke: 2/2 passed;
- dependency audit at `high`: zero vulnerabilities;
- `git diff --check`: passed;
- production line budget: 319 lines across the contract and evaluator, below
  the 400-line small-batch ceiling;
- allowlist: exactly five new paths; no existing file changed.

No migration or standalone integration program was added, so the literal
migration and integration script lists remain unchanged.

## Review status

Claude Opus 5 session `fdfba5be-90a6-4c4f-99d6-f9b32ba19329` returned `GO`,
P0=0 and P1=0. Its hardening notes led to exact hostile-input reasons, an
observable accessor non-execution proof, direct canonical-hash verification,
`stepId` hash coverage, multi-defect precedence checks, explicit numeric array
length validation and output-context guidance for opaque tenant bindings.

## Rollback

Revert the additive S9.B1a commit. No schema, script or external state changes.
