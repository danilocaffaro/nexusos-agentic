# S8.B6a1 + S9.B1b.1 composition evidence

## Candidates and order

The two-lane pipeline integrated the dependency-bearing workflow candidate
first, then the independent provider client boundary:

1. S9.B1b.1 `8219eedf77c080dc0aaf08254c01a0a0c16d5f9b`,
   tree `406b5c4a5d7b41bfcc51fe2cab030152ca91f3ff`;
2. S8.B6a1 `b4720ab9374a9fe104056e6d2e893969de36c7e9`,
   tree `621c36622ff51bb0ea29ecdcf8ae741606de4319`.

S9.B1b.1 was promoted by fast-forward from
`f31bd89576468eb2979656c8ff2c3850ee61eae3`. S8.B6a1 retained that same
frozen base and was integrated afterward by merge commit
`57d1d9ba1d195d9aa357c90809ce6d3bd05a347c`.

## Conflict guard

The guard compared both complete changed-path sets relative to their common
base. Their intersection was empty: no production, contract, test or
documentation path overlapped.

Before the real merge, `git merge-tree --write-tree` predicted combined tree
`82fea7dd367bbdf6205c6921aede92683775739c`. The real merge produced that
exact tree without a manual resolution. Both candidate worktrees were clean,
their allowlists were exact, and `git diff --check` passed.

## Independent reviews

- S9.B1b.1: explicit `claude-opus-5` review in session
  `b2c3f1a8-61ac-4f21-b5c8-97ea55ccb9d7`, final `GO`, P0=0, P1=0.
- S8.B6a1: explicit `claude-opus-5` review in session
  `ae57fa52-dbf3-4b6f-9e4e-3b9d37ffafea`. Its first pass opened four P1
  coverage/evidence findings. The corrected tree and final evidence were
  reread in the same session and returned `GO`, P0=0, P1=0.

No review result, count or tree identity was inferred across branches.

## Combined gates

All commands below ran serially from the integrated main tree:

- focused workflow-definition, workflow-run initialization and provider
  view-model suites: 28/28 passed;
- full unit glob: 452/452 passed;
- runner unit/contract suite: 477/477 passed;
- migrations and preflight: 39/39 passed;
- official integration programs: 11/11 passed;
- TypeScript, ESLint and Oxlint: passed;
- production build: passed;
- rendered smoke: 2/2 passed;
- production dependency audit at `high`: zero vulnerabilities; and
- worktree and diff hygiene: passed.

The composition activates no new effect. S9.B1b.1 remains a dark
`state_only_no_execution` genesis boundary. S8.B6a1 remains a dark
declared-only client anti-corruption layer with zero production consumers.
The visible provider demo is not removed until S8.B6a2.

## Rollback

Revert the composition-evidence commit, then revert merge
`57d1d9ba1d195d9aa357c90809ce6d3bd05a347c` to remove S8.B6a1. If necessary,
revert the S9.B1b.1 commits afterward. Neither candidate created schema,
external state, credentials, provider calls or execution effects.
