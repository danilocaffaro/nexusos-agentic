# P0 runner completed-rerun safety

## Defect

Running `nexus-runner diagnose` twice for the same completed run and state
directory selected the still-unexpired, acknowledged `lease.claim` from the
durable outbox as if it were live authority. The CLI printed `leased`, attempted
renewal, received `lease_superseded`, and exited 75.

The hostile regression reproduced that exact sequence before the fix:

```text
nexus-runner: Lease renewal lost its fenced authority (lease_superseded).
75 !== 0
```

## Safety invariant

An acknowledged `run.complete` receipt for the requested run is terminal local
evidence. After pending completion recovery and the existing foreign-claim
guard, `diagnose` now reports `already_completed` with success. It performs no
claim, renewal, or completion effect and does not print `leased`.

Crash replay is unchanged:

- a pending completion is delivered before this terminal check;
- a post-effect/pre-ack crash still replays the exact durable completion;
- an acknowledged completion can no longer reactivate an older lease;
- rejected, superseded, or abandoned completion entries are not treated as
  proof of completion.

## Regression evidence

`tests/runner-cli.test.mjs` proves:

- the original run renews and completes once;
- the rerun uses the same state directory;
- the server would reject any stale renewal with `lease_superseded`;
- the rerun exits 0 as `already_completed`;
- claim, renewal, completion, and outbox counts do not change;
- the existing post-effect crash replay test remains green.
