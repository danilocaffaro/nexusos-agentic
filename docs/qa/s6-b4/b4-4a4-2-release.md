# S6.B4.4a4.2 release evidence

## Outcome

B4.4a4.2 adds the internal, dedicated signed delivery path for an already
durable `engine.complete` outbox-v3 entry and a deterministic recovery drain.
It adds no CLI command, completion producer, claim, prompt read, supervisor,
child spawn, provider argument vector, serve loop or capability promotion.
Execution therefore remains `roadmap`.

The existing generic `deliverStoredOperation` continues to reject every v3
entry. Only `deliverEngineCompletion` can send an engine completion, and no
production command calls it in this batch.

## Per-entry delivery contract

Before network, the sender:

- validates the supplied entry as a pending v3 `engine.complete`;
- validates the runner id, exact saved audience and Ed25519 key pair;
- re-reads `outbox-v3/<operationId>.json` from disk;
- crosses the strict outbox parser and requires the disk checksum to equal the
  caller snapshot checksum;
- signs the exact decoded durable body bytes for the registry-derived pathname
  with domain `nexus-runner-engine-complete-v1`.

The disk re-read prevents a stale in-memory pending snapshot from resending and
overwriting a newer terminal tombstone.

Responses use the frozen a3 classifier, with one caller-side trust gate before
an irreversible transition. A destructive terminal scrub is committed only
when the response is attributable to the closed NexusOS error vocabulary.
Unknown or non-JSON gateway, WAF and proxy responses remain pending as protocol
failures. The classifier itself is unchanged.

| Observation | Durable action | Delivery result |
| --- | --- | --- |
| `200` plus exact ack | scrub to `acked` | frozen ack plus replay flag |
| network/reset/timeout, `5xx`, `429`, retryable `409` | remain `pending` | retryable, hint 75 |
| invalid ack, unexpected `2xx`, oversized response | remain `pending` | protocol, hint 76 |
| unknown/non-Nexus terminal envelope | remain `pending` | protocol, hint 76 |
| recognized superseded `409` | scrub to `superseded` | typed terminal error |
| recognized rejected terminal | scrub to `rejected` | typed terminal error |
| recognized `401`/`403 runner_rejected` | scrub current to `rejected` | auth, hint 77 |

Every terminal transition is durable before the sender returns or throws.
Terminal tombstones retain only body and response digests, response status and
timestamps. Results and errors expose no request bytes, response bytes or
unbounded server strings.

## Recovery drain

`drainEngineCompletionOutbox` selects only pending v3 engine completions and
sorts them by `createdAt`, then `operationId`. Duplicate supplied operations
fail before network. Each entry receives at most one HTTP attempt per pass.

The drain follows the Fable-approved improved-B rule:

- continue after per-run `superseded` or non-auth `rejected` outcomes because
  those entries are already scrubbed and cannot justify starving another run;
- halt on retryable, protocol or auth outcomes because those causes can affect
  the shared environment or identity;
- on auth, scrub only the current recognized entry and leave every later
  replay body untouched;
- return a frozen report with attempted, delivered, failed, halt and
  batch-relative `remainingPending` facts.

The caller must hold the single-writer state/outbox lock. A local durable-state
or I/O fault still throws and may prevent a partial report from being returned;
the already-written entry states remain authoritative. The future public
`serve` command must map the error hints, stop permanently on auth/77 instead
of rescheduling, and surface outbox quarantine events.

## Automated evidence

The focused delivery suite proves:

- a real Ed25519 signature over the exact body, domain, runner, path, audience,
  timestamp and nonce, including a tamper-negative verification;
- strict ack, replay visibility and scrubbed ack tombstone;
- stale post-ack and self-consistent disk/snapshot divergence reject before
  network and cannot rewrite the durable file;
- server, conflict, nonce and connection failures preserve byte-identical
  pending entries;
- response overflow and invalid success acknowledgements halt as protocol;
- a real post-header socket reset is retryable rather than protocol;
- unknown HTML `404` and `403` responses cannot trigger destructive scrub;
- every recognized superseded, rejected and auth branch scrubs before its
  typed error;
- terminal files and in-memory outcomes exclude encoded request and raw
  response markers;
- deterministic drain continuation and halt behavior, including auth blast
  radius and batch-relative pending counts;
- duplicate, malformed and invalid-context inputs issue zero requests;
- imports are inert, direct CLI execution works through a symlink, and help
  plus unknown-command behavior remain unchanged.

The release pipeline passed before commit:

- typecheck;
- 218/218 unit tests;
- 145/145 runner tests across 118 top-level cases;
- 38/38 migration and preflight tests;
- all seven API integration suites;
- production build and 2/2 rendered-artifact smoke tests;
- ESLint and Oxlint;
- production dependency audit with zero vulnerabilities;
- Drizzle generation with no schema drift; and
- `git diff --check`.

Quality gates that traverse or mutate ephemeral test directories run
sequentially in one checkout, as the checked-in CI workflow already specifies.
An exploratory parallel invocation demonstrated that sharing the checkout can
race directory discovery with teardown; both affected gates passed when
re-run in the supported sequential order.

## Review and rollback

Fable selected the improved-B drain and separately approved the
application-attribution gate for destructive responses. The initial Opus
review found three P1 gaps: stale snapshots, post-header transport
classification and unattributed terminal scrub. All were corrected. The
corrected Opus re-gate returned `PASS/GO`, P0=0/P1=0. The final post-pipeline
Opus delta also returned `PASS/GO`, P0=0/P1=0. Its three non-blocking P2
observations concern only future hardening of two static test anchors and
making one already-verified caller relationship even more explicit in this
evidence; runtime spawn tests, help-surface assertions and a repository-wide
caller search independently cover the same release claims.

Rollback removes the two exported internal functions, their error type, the
import-safe direct-execution guard and the focused tests. No durable format or
server schema changes in this batch, so existing v3 entries remain readable by
the preceding version.
