# S5.B4b QA results

## Outcome

Automated and browser acceptance passed on 2026-07-26. Opus returned `PASS`
with no P0/P1 in the full and post-fix delta reviews.

## Automated evidence

- TypeScript and 78 unit tests passed.
- All 16 migrations applied to an empty D1-compatible SQLite database; the
  three migration suites passed.
- Governance, presence, realtime and artifact API integrations passed.
- The artifact integration proved authorization, stale-head rejection,
  self/equal-content rejection, exact declare/retract retries, one active
  outbound conflict, inbound navigation, stale target disclosure and a
  three-node recursive cycle across a later source version.
- The same integration asserts exactly three declaration events, one
  retraction event, both lifecycle events for the original relation and a
  valid organization ledger after the complete sequence.
- Migration tests exercised ineligible human/agent writers, forged head pins,
  active-source uniqueness, declared/retracted ledger event shape and
  uniqueness, immutable update/delete and recursive-cycle rejection.
- The production build and rendered-HTML smoke test passed.
- The read model loads the active outbound relation separately from its
  bounded 100-entry retraction history, so history truncation cannot hide
  active state.

The depth-100 fail-closed branch and a 100-source inbound truncation fixture
remain explicit scale-test gaps; neither changes the enforced SQL path used by
the recursive-cycle and bounded-read tests. Concurrent supersession calls are
covered by database constraints and transactional D1 batches, but a dedicated
two-writer API fixture remains a hardening test.

## Browser evidence

Against the local D1-backed application at `http://localhost:3001`:

- declared an erased source artifact as replaced by a live target;
- observed exact source/target version and hash pins plus truthful
  `PAYLOAD INDISPONÍVEL · HASH RETIDO` disclosure;
- followed the replacement to the target and observed its inbound relation;
- returned to the source, acknowledged the retraction warning and retracted;
- observed the retained retracted history and restored declaration form.

The real relation `5caa784a-47cf-4830-9a88-df2883d698aa` is retained as
`retracted`. Ledger entries `#131 supersession.declared` and
`#132 supersession.retracted` share its typed payload reference, and the
organization ledger verifies as valid through entry 132.

## Non-effects

The integration confirms supersession does not change the artifact's current
version or `updated_at`. Existing review and decision-evidence code paths
remain independent and the complete regression suite passed.
