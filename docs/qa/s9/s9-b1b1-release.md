# S9.B1b.1 release evidence — workflow-run initialization

## Candidate

S9.B1b.1 is a dark, additive candidate implementing initialization only. The
exact six-path allowlist is:

- `src/contracts/workflow-run.ts`
- `src/domain/workflows/workflow-run.ts`
- `tests/unit/workflow-run-initialize.test.ts`
- `tests/unit/workflow-definition.test.ts`
- `docs/adr/S9B1b1-workflow-run-initialization.md`
- `docs/qa/s9/s9-b1b1-release.md`

The architecture split and contract were ratified by Claude Fable session
`c0445304-ff3d-418d-ac16-bc31ebdc5c22` and Claude Opus 5 session
`f51f8907-4b7d-4c4d-af29-0d9a31363bba`: `AGREE`, P0=0, P1=0.

## Truth boundary

The only positive claim is `state_only_no_execution`. The candidate produces a
complete immutable initial snapshot and genesis record from a raw, re-evaluated
S9.B1a declaration. It has no transition reducer, replay, persistence, route,
UI, trigger, scheduler, provider, secret, effect or execution adapter. The
combined S9.B1b program item remains incomplete; no program-plan state changes
are part of this lot.

## Gates

Executed from the isolated S9.B1b.1 worktree:

- focused unit: 16/16 passed;
- full unit glob: 440/440 passed;
- TypeScript: passed;
- ESLint and Oxlint: passed;
- production build: passed;
- rendered smoke: 2/2 passed;
- production dependency audit at `high`: zero vulnerabilities;
- `git diff --check`: passed;
- production line budget: 261 lines across contract and initializer, below the
  300-line ceiling;
- allowlist: exactly the six authorized paths, including the one sanctioned
  S9.B1a consumer-gate modification.

No migration or integration program was added because this lot has no storage
or side-effect boundary.

## Review status

Claude Opus 5 session `b2c3f1a8-61ac-4f21-b5c8-97ea55ccb9d7`
independently re-derived the allowlist, line budget, consumer boundary,
determinism, hostile-input behavior, semantic contract, truth claims and
rollback. Final verdict: `GO`, P0=0, P1=0.

Its optional P2 notes concern a simplifying TypeScript union, deliberately
declared future-event vocabulary, a fail-closed helper implementation detail
and this evidence line being pending before review. None changes runtime
behavior or expands the authorized lot.

## Rollback

Revert the S9.B1b.1 commits. No schema, script, deployment or external state
changes are involved.
