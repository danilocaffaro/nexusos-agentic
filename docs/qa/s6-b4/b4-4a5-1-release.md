# S6.B4.4a5.1 release evidence

## Outcome

B4.4a5.1 removes the future serve owner's self-deadlock without adding a
serve command or any production caller. The existing coordinator wrapper
still acquires, uses and releases the process lock exactly once. A future
already-owning caller can invoke the same dark recovery core only with an
opaque capability minted by the successful lock acquisition.

This slice activates no heartbeat, claim, prompt read, network caller,
provider process or capability label. In particular, completion HTTP still
occurs under the current lock and remains a hard blocker for a5.3/a5.4.
Execution remains `roadmap`.

## Ownership contract

- The module-private `WeakMap` is the only issuer and registry of ownership;
  booleans, strings, numbers, nulls, undefined and arbitrary functions cannot
  forge a capability.
- Ownership is bound to the exact state directory and active acquisition.
- `withOutboxLockOwnership` validates and marks one atomic borrow before its
  first await, then clears the borrow in `finally`.
- Nested/concurrent borrow and release during a borrow fail closed without
  touching the pidfile.
- Release becomes inactive synchronously before its first await and is
  one-shot. A stale second release cannot delete a new owner's lock.
- A filesystem failure after release begins leaves the capability invalid.
  This deliberately fails toward over-locking; the public serve shutdown
  design must record and handle that P2 without retrying a stale release.
- The compatibility wrapper waits for the borrow to end and releases in its
  outer `finally`, including core, drain and validation failures.

## Automated and review evidence

The focused suite passes 47/47 tests and includes adversarial proof for forged,
wrong-directory, released, concurrently borrowed and stale capabilities. It
reproduces the previously unsafe sequence — release old, acquire new, release
old again — and proves the new lock remains present and authoritative.
Syntax, focused ESLint/Oxlint and `git diff --check` also pass.

Fable's architecture gate identified lock reentrancy and HTTP-under-lock as
the two activation P1s. An independent integration guard rejected the first
draft because its release was reusable and ownership was not borrowed across
awaits. The atomic borrow and one-shot invalidation closed the reproduced
race; the guard returned GO, P0=0/P1=0. The final exact-model Opus 5 delta
returned `PASS/GO`, P0=0/P1=0.

The repository-wide pipeline also passed:

- typecheck;
- 238/238 unit tests;
- 198/198 runner tests;
- 38/38 migration and preflight tests;
- all seven API integration suites;
- production build and 2/2 rendered-artifact smoke tests;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities; and
- `git diff --check`.

The next slice is a5.2 recovery/rollback hardening; a5.3 must remove HTTP from
the state borrow before any public serve caller can be considered.

## Rollback

Rollback removes the held-owner entrypoint and ownership registry while
retaining the prior coordinator wrapper. No stored outbox or journal shape,
server schema, route, prompt, receipt or provider adapter changes in this
slice.
