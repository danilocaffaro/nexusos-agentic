# S6.B1 QA results

## Outcome

Automated, adversarial, real-CLI and browser acceptance passed on 2026-07-26.
The final Opus delta review returned `PASS` with no residual P0/P1 after both
blocking CLI/UI findings were closed.

This batch proves signed machine enrollment and truthful liveness under
`operator_trust`. It does not claim leases, execution, sandboxing, host
attestation, provider engines or outcome evidence.

## Automated evidence

- TypeScript and ESLint passed.
- 101 unit tests passed, including canonical base64url, deterministic runner
  identity, low-order Ed25519 rejection, exact signature envelopes, timestamp
  and liveness boundaries, canonical configured audience and truthful UI copy.
- Five dependency-free runner CLI tests passed:
  - a dropped enrollment response retains and reuses the byte-identical key;
  - a first-attempt definitive rejection removes the newly staged key;
  - a later rejection never removes a retained recovery key;
  - enrollment secrets never appear in supported or mistaken argv forms,
    stdout, stderr or persisted state;
  - a chunked response without `Content-Length` is stopped at 64 KiB while the
    recovery key remains available.
- All 17 migrations apply from empty state; all four migration tests passed.
  The runner migration tests reject identity mutation, token un-consumption,
  invalid lifecycle changes and inconsistent ledger references.
- Governance/workspace, presence, realtime, artifacts and runner API
  integrations passed.
- Production build and rendered-HTML smoke passed.
- Production dependency audit reported zero vulnerabilities at the configured
  high-severity gate.
- Drizzle generation reported no schema drift and `git diff --check` passed.

## Runner API evidence

The runner integration proves:

- owner/admin-only token issuance and revocation with cross-tenant isolation;
- real Node Ed25519 enrollment, same-token/same-key byte-stable recovery and
  uniform rejection for unknown, revoked, expired or wrong-key tokens;
- one winner across eight different keys racing for one token, with exactly one
  principal, runner and `runner.enrolled` event;
- configured canonical audience cannot be replaced by Host or forwarded-host
  headers and is returned by the authenticated registry for the CLI command;
- strict body limits, exact `{}` heartbeat bytes, canonical unpadded key,
  signature and nonce encodings, low-order-key rejection and both clock-skew
  limits;
- exact heartbeat replay is byte-stable and does not advance `last_seen_at`;
  changed bytes under one nonce fail, and concurrent identical requests
  converge on one fresh response plus one replay;
- revocation disables runner and principal immediately and the complete
  governance ledger still verifies.

## Real CLI evidence

Against `http://localhost:3001`, an owner issued a real one-time token through
the UI. The reference CLI:

1. generated an Ed25519 identity locally;
2. enrolled from standard input without placing the token in argv or env;
3. persisted a `0600` PKCS8 private key inside a `0700` directory;
4. sent a signed heartbeat and received the server observation;
5. caused the UI to project the runner as `Online`.

A separate real PTY probe used `--token-stdin` interactively. The CLI displayed
the hidden prompt, accepted the value without terminal echo, received the
expected uniform `403` for a dummy token and removed the newly staged key.

The real QA runner was revoked through the governed endpoint after acceptance.
Its temporary private state was moved to Trash. No test token or active test
runner remains.

## Browser evidence

Desktop and 390 × 844 acceptance covered:

- Runners navigation from the governance sidebar and from the mobile command
  palette;
- the full, prominent operator-trust disclosure;
- four honest capability cards: identity and heartbeat `REAL`, execution and
  sandbox `ROADMAP`;
- one-time token ceremony with separate copy controls and a setup command that
  contains no token;
- server-provided canonical audience in that command;
- automatic registry refresh from empty to `Online`, fingerprint, trust
  profile, enrollment time and last heartbeat;
- guarded runner revocation and token cancellation;
- 390 px page width with no horizontal page overflow. The token ceremony
  measured 354 px wide with 352 px internal content.

## Defects found and closed

The first API implementation review blocked on unbounded request allocation,
overbroad conflict classification, post-commit cleanup coupling, concurrent
revocation proof and an incorrect token response shape. All were closed before
the API commit.

The CLI/UI review then blocked on two P1 defects:

1. a retry rejected after an ambiguous success could delete the only recovery
   key;
2. the setup command guessed `window.location.origin` instead of using the
   deployment-configured signing audience.

The final implementation preserves retained keys, removes only a key created
by the current rejected invocation, exposes only the canonical audience through
the authenticated registry and fails closed when it is missing or invalid.
Opus verified both corrections and returned `PASS`.

Browser acceptance additionally found and closed an interactive-TTY echo path
and a missing mobile route to runner management.

## Residual scope

- Dead enrollment-lock recovery and packaged installer ergonomics can harden
  the CLI without changing the protocol.
- Distributed rate limiting and edge deployment validation remain pre-GA
  controls.
- Key rotation, attestation, leases, fencing, outbox replay, sandbox,
  `ExecutionEngine`, streaming, cancellation and outcome receipts belong to
  later Sprint 6 batches and remain visibly labeled roadmap.
