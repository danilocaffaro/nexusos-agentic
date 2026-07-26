# S6.B2 QA results

## Outcome

Automated, adversarial and real-CLI acceptance passed on 2026-07-26. The final
Opus delta review returned `PASS` with zero residual P0/P1.

This batch proves fenced coordination and crash-safe semantic replay for one
closed diagnostic. It does not execute user work, start a shell or provider
CLI, sandbox a host, stream arbitrary output or attest runner integrity.

## Automated evidence

- TypeScript, ESLint and `git diff --check` passed.
- 107 unit tests passed, including canonical run contracts, detached signing,
  operation hashing, truthful capability labels and direct classification of
  the D1 `invalid_run_event` concurrency signal.
- Six dependency-free runner CLI tests passed. The diagnostic case proves that
  an operation persisted before network I/O survives a post-effect crash,
  restarts with the same operation id and is applied once.
- All 19 forward migrations apply from empty state; five migration suites
  passed. Storage rejects two active leases for one run, stale event sequence,
  invalid fence/generation, mutable run events, invalid terminal outcomes and
  operation-tombstone deletion.
- All six API integration programs passed: governance/workspace, presence,
  realtime, artifacts, runner identity and diagnostic runs.
- The run integration used two real Ed25519 runners and proved exact
  nonce/operation replay, renew, expired-lease reassignment, zombie completion
  rejection, revocation before cached replay, cancellation convergence and a
  real CLI completion.
- Production build, rendered-HTML smoke and production dependency audit passed;
  the audit reported zero vulnerabilities at the configured high-severity
  gate.
- Drizzle generation reported no schema drift.

## Defects found and closed

The first Opus implementation review found four P1 defects:

1. revocation did not revoke active leases;
2. cancellation could remain leased after the holder disappeared;
3. renewal at the run deadline rejected a valid unchanged expiry;
4. repository race classification missed real trigger errors.

The fixes atomically disable the runner and revoke its active leases, converge
expired cancellation through `leased -> queued -> canceled`, permit monotonic
equal-expiry renewals, emit explicit release events and classify both unique
index and trigger aborts for whole-batch retry.

The first final review then found one remaining P1: the revocation retry
recognized a unique-index message that the `run_events` trigger prevents from
ever surfacing. The final delta shares a tested
`isRunEventSequenceConflict` classifier containing the real
`invalid_run_event` signal. Opus verified the read-head and guarded batch are
recomputed on every retry and returned `PASS`.

## Browser evidence and deferral

The in-app browser controller timed out repeatedly while navigating the healthy
local server, even after a clean server restart. Per the Opus release decision,
QA plan items 23–24 are explicitly deferred rather than represented as passed.
Substitute evidence is green: production RSC/SSR build, rendered smoke and
structural UI tests cover the diagnostic section, non-secret command, honest
capability labels and unchanged operator-trust disclosure.

Desktop/mobile interactive acceptance must be rerun when the controller is
available and remains a pre-GA visual gate.

## Residual scope and registered debt

- Before S6.B3 enables multi-run concurrency, runner revocation must remove its
  20-row lease query bound or storage must enforce the supported per-runner
  active-lease bound.
- Before GA security sign-off, `ledger_entries` needs storage-level
  update/delete denial. Today it is application-append-only and tamper-evident
  through its hash chain, not storage-immutable.
- Exhaustive concurrent-claim, operation-horizon and retention-pruning tests
  remain required before arbitrary execution is promoted from roadmap.
