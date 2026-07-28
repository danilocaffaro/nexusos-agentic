# S6.B4.4a5.2 release evidence

## Outcome

B4.4a5.2 hardens crash recovery and rollback without adding a serve command
or production caller. Invalid or hostile attempt paths are quarantined in a
bounded pass instead of wedging recovery. A terminal `abandoned` completion is
settled locally, reported for operator attention and never becomes
network-eligible.

This dark slice activates no heartbeat, claim, prompt read, provider process,
HTTP caller or capability label. Execution remains `roadmap`.

## Deliberate v1 contract evolution

This slice deliberately extends the v1 `settled.outcome` vocabulary to
`acked`, `abandoned`, `rejected` and `superseded`. It supersedes the a4.4
statement that the closed vocabulary contained only `acked`, `rejected` and
`superseded`. The outcome remains the exact mirror of the correlated terminal
v3 outbox status; unknown values such as `failed` still fail closed.

The extension is intentional rather than silent. A v2 record would have the
same rollback radius: the immediately preceding reader quarantines either an
unknown record version or a v1 record with an unknown outcome. Keeping the
single record shape avoids a second permanent vocabulary without weakening
rollback safety.

An `abandoned` settlement performs no completion network request. Its
reconciliation pass emits
`operator_attention/completion_operation_abandoned`, while `settled.json`
holds the durable terminal truth and removes the attempt from the actionable
window.

## Retention and ordering

- Terminal v3 outbox tombstones, including `abandoned`, are retained for seven
  days.
- Settled attempt journals, including `abandoned`, are retained for eight days
  and pruned in batches of at most 32.
- Settled attempts count in `settledRetained` and do not consume later
  actionable recovery windows. The reconciliation pass that first writes
  `settled.json` does consume one bounded slot; the next pass admits deferred
  actionable work, preventing persistent starvation.
- Every activated cycle must reconcile attempts before terminal outbox
  pruning. B4.4a5.3 owns that ordering invariant; no production cycle or
  outbox-prune caller is activated in this dark batch.

## Rollback contract

Rollback is pinned at three levels:

1. The checked-in compatibility model is explicitly pinned to the immediately
   preceding reader commit `2682913`. That reader knows `settled.json` but
   accepts only `acked`, `rejected` and `superseded`. It quarantines an
   `abandoned` settlement as invalid. The model proves this is noisy but safe:
   zero network, no unmatched pending entry and no redeclaration before or
   after the seven-day tombstone prune.
2. The pre-settled reader treats `settled.json` as unknown and quarantines the
   whole attempt. Existing proof likewise keeps terminal and pending
   completions off the network.
3. Rolling forward does not silently resurrect quarantined attempts. An
   operator must inspect and explicitly resolve `attempts-v1/corrupt/`.

Rolling back also re-exposes the preceding reader's pre-existing durability
defect for a result-only journal whose terminal tombstone was already pruned.
That is not introduced by this slice and remains covered by the a5.3
reconcile-before-prune activation invariant.

## Staged cleanup safety

- `lstat` rejects non-directories, symlinks, wrong owners and missing owner
  permissions before the descriptor-based second check.
- `ENOENT` at recovery loop boundaries is treated as a completed concurrent
  removal.
- A private staging directory whose recursive removal fails because of a
  hostile nested subtree is renamed into `corrupt/` and reported through
  `onCorrupt`; an eligible sibling can still be pruned in the same pass.
- `EMFILE`, `ENFILE`, `ENOMEM`, `EDQUOT`, `EIO`, `ENOSPC` and `EROFS` remain
  infrastructure failures at both descriptor inspection and recursive
  removal, and propagate instead of being mislabeled as corrupt content.
- Staged processing and removal remain bounded at 32 entries per pass.
- Quarantined hostile trees can require an operator-owned `chmod` before
  manual cleanup.

## Automated acceptance

The focused gate must prove:

- the extended closed vocabulary accepts `abandoned` and rejects `failed`;
- exact immediately preceding and pre-settled reader rollback models;
- zero completion network eligibility for `abandoned`, before and after
  tombstone pruning;
- 32 abandoned settlements cannot monopolize the actionable window;
- terminal retention and bounded pruning;
- invalid file, symlink, directory-permission and nested-removal cases
  quarantine without touching an external sentinel or starving an eligible
  sibling; and
- a quarantined journal cannot make a pending completion network-eligible.

The local best-effort supervisor acknowledgement is reachable while an
`abandoned` tombstone is being settled. It is process-local, guarded by the
supervisor identity and swallowed on failure; it does not issue completion
HTTP and does not change the dark capability surface.

## Release gate

The focused gate passed 54/54 tests with focused ESLint, Oxlint and
`git diff --check`. The independent integration guard ran an expanded
67/67 journal/outbox gate and returned GO, P0=0/P1=0 after finding and closing
the descriptor-open storage-failure classification mismatch.

Fable's architecture arbitration selected deliberate v1 evolution over a
permanent poison marker or a redundant v2 record, conditioned on explicit
supersession and exact rollback proof. Both conditions are checked in. The
final exact-model Opus 5 review returned PASS/GO, P0=0/P1=0; its incremental
review also confirmed the guard finding was closed without activating a
production caller.

The repository-wide pipeline passed:

- typecheck;
- 251/251 unit tests;
- 205/205 runner tests;
- 38/38 migration and preflight tests;
- all seven API integration suites;
- production build and 2/2 rendered-artifact smoke tests;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities; and
- `git diff --check`.

B4.4a5.3 remains blocked from activation until completion HTTP is outside the
lock-owned filesystem prepare/finalize sections and every activated cycle
reconciles journals before pruning terminal outbox tombstones.
