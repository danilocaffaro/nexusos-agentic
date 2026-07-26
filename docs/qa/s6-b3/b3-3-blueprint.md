# S6.B3.3 signed reporting blueprint

> Architecture gate: Fable `GO-WITH-CONDITIONS`
> Date: 2026-07-26

## Reversible delivery slices

### B3.3a — server mutation plane

- a dedicated signed capability-report adapter binds runner key id, exact
  pathname, audience, timestamp, nonce and canonical body bytes;
- active runner and active runner principal are checked before nonce or
  semantic replay and again at the storage boundary;
- nonce identity uses the signed-request hash, while permanent report identity
  uses the nonce-independent operation hash;
- one D1 batch writes report, ordered evidence, the 201 nonce response and
  runner liveness;
- exact nonce and semantic replay return stored response bytes; conflicts are
  closed and compacted semantic ids return permanent `410`;
- mutation-time maintenance deletes at most 100 oldest expired nonces and
  compacts at most 100 oldest 30-day responses; GET remains pure;
- trigger-only migration 0020 makes monotonic receive-time validation seek the
  organization/runner history index.

### B3.3b — runner durability plane

- new operations are v2 files in the sibling `outbox-v2/` directory;
- pending v1 claim/completion entries remain v1 and transition in place;
- downgrade ignores and preserves v2 files; re-upgrade resumes them;
- `report-capabilities --dry-run` emits an all-unknown, probe-disabled canonical
  baseline with no network or outbox I/O;
- normal submission fsyncs the v2 report before the first send, resumes one
  pending report after a crash and never claims host detection before B3.4.

## Normative ordering

1. Validate canonical path/body and configured audience.
2. Resolve the path-bound active runner and verify the detached signature.
3. Re-check active state before nonce replay.
4. Resolve nonce replay, then permanent semantic replay.
5. For a fresh report, derive monotonic server receive time and exact response.
6. Commit report, evidence in ascending position, nonce and liveness atomically.
7. Classify an aborted batch by nonce, semantic id and current runner state.
8. Run bounded maintenance after a successful mutation, swallowing maintenance
   failure without changing the committed response.
9. On the runner, fsync the derived v2 entry before any network request.

## Zero-tolerance gates

- semantic `request_hash` never contains nonce or timestamp;
- revocation before replay never returns cached success;
- concurrent equal report ids converge to one row and exact response bytes;
- changed bytes under one nonce and one report id remain distinguishable;
- error responses are never stored in the nonce table;
- compaction is one-way and `410` performs zero replay/nonce writes;
- outbox v1 and v2 never share an entry directory;
- production pre-probe reports contain no `available` status;
- no API or UI capability label moves from `roadmap`;
- all existing B2 runner, lease and GET-purity behavior remains green.

## Rollback

B3.3a can be reverted to B3.2 without deleting written history: B3.2 already
reads the same append-only rows. Migration 0020 changes only one trigger body.
B3.3b can be downgraded to runner 0.2 because v1 files stay in `outbox/` and v2
files remain untouched in `outbox-v2/`; a later re-upgrade resumes them.
