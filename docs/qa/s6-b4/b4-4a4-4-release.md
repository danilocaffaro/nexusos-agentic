# S6.B4.4a4.4 release evidence

## Outcome

B4.4a4.4 closes the dark recovery transaction between one immutable local
engine-attempt journal and one durable `engine.complete` outbox operation. It
adds no public runner command, claim loop, prompt fetch, provider spawn,
continuous scheduler or capability promotion. Local engine execution
therefore remains `roadmap`.

Fable selected a single-writer coordinator with an injected completion drain
instead of importing the public runner. The resulting module remains
import-inert, avoids a future ESM cycle and preserves the existing outbox-v3
and completion-sender contracts.

## Recovery and settlement contract

- Completion identity is deterministic from a domain-separated canonical
  `{attemptId, domain}` digest, so replay cannot declare a second operation.
- A result is persisted to the outbox before the journal may advance to
  `outboxed`; an exact pending or scrubbed-terminal entry is safely adopted
  across either crash gap.
- Only an exact attempt/run/operation/body bijection reaches the injected
  drain. Mismatches and orphans are attention-only and perform no network
  effect.
- Already-terminal correlated entries settle without delivery. Only pending
  correlated entries can enter the drain.
- The terminal `settled` journal state is closed as `acked`, `rejected` or
  `superseded` and is bound to the exact outboxed operation.
- One pass handles at most 32 actionable attempts and 16 deliveries. Work is
  priority ordered, settled attempts do not monopolize the action window and
  all recovered result identities participate in orphan correlation.
- Drain output is strictly validated and copied into frozen,
  coordinator-owned values. Invalid or noncanonical reports fail closed and
  still release the state lock.
- Per-attempt failures are isolated. A settlement persistence failure cannot
  discard another attempt's safe outcome.
- Exit hints 75 and 76 remain nonpermanent. Hint 77 becomes a permanent stop
  only after the real drain has durably transitioned the exact entry to
  rejected.
- Settled journals remain for eight days, one day longer than terminal outbox
  retention. At most 32 expired journals are atomically renamed out of the
  active namespace, root-fsynced and removed per pass.
- The coordinator does not resume `waiting_spawn`, `waiting_input` or running
  provider work. Live scheduling belongs to the next serve-loop slice.

## Automated evidence

The focused post-review suite passed 46/46 tests and proves:

- deterministic operation identity and one durable completion under replay;
- acknowledgement, settlement and later outbox pruning without redeclaration;
- adoption of exact pending and already-scrubbed terminal crash-gap entries;
- zero delivery for mismatched and orphaned completion entries;
- deterministic recovery ordering and exact 32-attempt/16-delivery bounds;
- settled-window fairness and immutable pre-drain deferral accounting;
- exact bounded retention with 32 removals and eight survivors;
- no result synthesis from ambiguous supervisor identity;
- exclusive lock behavior and release on both success and typed failure;
- strict rejection of missing and noncanonical drain reports;
- exact 75/76/77 permanent-stop behavior; and
- import inertness and absence of a public-runner dependency cycle.

Focused Node syntax, ESLint, Oxlint and `git diff --check` gates also passed.
The complete release pipeline then passed:

- typecheck;
- 228/228 unit tests;
- 197/197 runner tests;
- 38/38 migration and preflight tests;
- all seven API integration suites;
- production build and 2/2 rendered-artifact smoke tests;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities; and
- `git diff --check`.

## Review and activation gates

The first Opus 5 review found two P1 classes: no closed terminal journal state
and unbounded recovery under one lock. A second review found that terminal
entries could monopolize the 32-item window and that post-drain mutation made
the deferred count invalid. The implementation added closed settlement,
bounded atomic retention, priority/correlation fairness, per-attempt isolation
and pre-drain immutable accounting. The final exact-model review returned
`PASS/GO`, P0=0/P1=0.

The following P2 items are carried explicitly into B4.4a5:

- reconcile attempts before terminal-outbox pruning on every activated cycle;
- schedule lock ownership so bounded HTTP delivery cannot starve live
  heartbeats, claims or renewals;
- harden cleanup behavior for unexpected staging-shaped owner files;
- assert the currently unreachable abandoned-terminal case;
- define rollback handling for an older binary that cannot parse `settled`;
  and
- preserve the invariant that only one production serve process owns the
  state directory.

Rollback removes the coordinator, the `settled` record variant and their
focused fixtures/tests. The public runner, server schema, API routes and
provider adapters are unchanged by this dark slice.
