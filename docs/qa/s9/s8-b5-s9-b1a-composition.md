# S8.B5 + S9.B1a composition evidence

## Composition

Two independent lanes started from
`3f3cfdc2e86ed83a64ce934fe3351e13be2ff6d5`.

- S8.B5 candidate: `60e186c3be06b0d7582eff8ea6b4af5b8a7fabd3`,
  tree `3ffa2822482b5449cc9ba24fb8bae44905142991`.
- S9.B1a candidate: `8ddee6a77d6f19d4832e68ff0babd94e1b233d3e`,
  tree `8876ee4ebc838c2611bc046268ace1be5046549c`.
- composed merge: `d4cfc3c762a1bf87e9f18b28454eb832a2196844`,
  tree `2595f792bc4dde84c95a3ab2006d59f747aa762d`.

The lane path intersection was empty. `git merge-tree --write-tree` calculated
`2595f792bc4dde84c95a3ab2006d59f747aa762d` before the merge; the resulting
tree matched it exactly. S8.B5 entered first by fast-forward, then S9.B1a by an
explicit merge commit.

## Combined serial gate

The complete gate ran once, serially, from the composed tree:

```text
TypeScript: PASS
Unit glob: 434/434 PASS
Runner unit/contract suite: 477/477 PASS
Migrations: 39/39 PASS
Official integration programs: 11/11 PASS
Production build: PASS
Rendered smoke: 2/2 PASS
ESLint + Oxlint: PASS
Dependency audit at high: zero vulnerabilities
git diff --check: PASS
```

The build route table contains both `GET /api/providers/catalog` and
`POST /api/providers/cli-session-observation`. The workflow definition remains
dark and has no pre-existing production consumer.

## Guard findings

The integration guard found and closed two defects before release:

1. an arbitrary catalog-source rejection could become 500 on the B4 route;
   S8.B5 now normalizes only source acquisition failures to 503 while preserving
   later adapter failures as 500;
2. the initial S8.B5 evidence mislabeled the 477-test runner suite as the unit
   glob; the corrected S8 counts are 424 unit and 477 runner, while this combined
   tree has 434 unit and 477 runner.

No test was executed concurrently with the official integration chain.

## Review provenance

- Fable S8.B5 architecture:
  `e30c62c4-e3df-4818-880d-a6b8afaf8d6d`, GO, P0=0, P1=0.
- Opus 5 S8.B5 final review:
  `ff405ff7-9e0e-42bf-bcac-87e93e53b4f2`, GO, P0=0, P1=0.
- Fable S9.B1 architecture:
  `889046d4-c1a8-4a9b-99e8-1b95903039ce`, corrected GO, P0=0, P1=0.
- Opus 5 S9.B1a final review:
  `fdfba5be-90a6-4c4f-99d6-f9b32ba19329`, GO, P0=0, P1=0.

## Rollback

The lanes remain independently reversible. Reverting S9.B1a removes only five
additive dark-contract files. Reverting S8.B5 removes its five new files and
restores its five modified files. Neither rollback strands schema, data,
credentials or provider state.
