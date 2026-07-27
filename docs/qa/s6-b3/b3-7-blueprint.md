# S6.B3.7 trust-boundary UI blueprint

> Status: PASS
> Consensus: Codex + Fable + Opus 5
> Delivery: small, reversible batches with a green gate after every commit

## Outcome

The Runners workspace becomes the truthful operating surface for signed host
declarations, their history, organization admission policy and assigned
diagnostics. It explains what the server observed and how the declaration
clause evaluates at read time without claiming that a host was attested,
sandboxed or guaranteed to receive a run.

## Information architecture

1. The existing capability strip marks capability reporting as `REAL` only at
   release; Sandbox, Execution and Streaming remain `ROADMAP`.
2. One organization policy panel distinguishes virtual default, configured
   allow-list and configured deny-all. Every member may read it; only a
   server-provided permission reveals editing.
3. Every runner card shows identity/heartbeat facts and an adjacent
   `DECLARADO · hostReported` summary. Inline expansion reveals seven closed
   capabilities, server receipt age, host collection time, platform,
   truncation and declaration-policy explanation.
4. Inline history uses the existing opaque cursor and “Carregar mais”.
5. Diagnostic creation supports pool or assigned mode. Assigned mode selects
   an active runner and an optional required capability.
6. Run cards distinguish pool/assigned work, required capability and derived
   expiry without rewriting the stored status.

## Trust language

- `receivedAt` is authoritative server time.
- `collectedAt` is only the time reported by the host.
- `hostReported` is a signed assertion, not verification.
- `declarationAdmission` is a partial read-time projection. It has
  `evaluatedAt`, policy source/version, freshness and per-capability facts, but
  no top-level `eligible`. Future host timestamps and invalid policy state are
  distinct from stale and absent declarations.
- The server performs the complete, authoritative evaluation at claim time.
- `truncated` means the declaration is incomplete; absence is not
  unavailability.
- `expired` on a read is derived and leaves the recorded run status unchanged.

## State and concurrency rules

- Runner registry, policy, per-runner history and run mutations have
  independent loading/error/empty states.
- Switching or collapsing history invalidates older requests so a late
  response cannot populate the wrong runner.
- Background polling may refresh read-only facts. It pauses while a policy
  form is dirty.
- Policy edit freezes `expectedVersion` when editing starts. A 409 refreshes
  server facts, preserves the draft and requires an explicit new submission.
- A policy change never claims to invalidate an already-active lease; lease
  metadata keeps the policy/report pins used at claim.
- Assigned runs never fall back to the pool.

## Small batches and gates

### C0 — Local migration hygiene

- Add `predev` for idempotent local D1 migration.
- Prove clean and existing `.wrangler/state` startup paths.
- Commit only package/runtime documentation changes.

### C1 — Shared declaration oracle

- Extract the declaration clause from `evaluateClaimAdmission`.
- Keep claim behavior byte- and error-compatible.
- Add the differential matrix from QA item 53.
- Gate: unit, runs integration, typecheck, lint and Opus implementation review.

### C2 — Bounded registry read model

- Add one organization policy view and per-runner
  `declarationAdmission`.
- Evaluate once per registry snapshot using a single canonical `evaluatedAt`.
- Keep GET pure and the response bounded by the existing runner limit.
- Keep `capabilityProfiles` as `roadmap`.
- Gate: runners integration, read-purity, query-shape inspection and Opus
  review.

### C3 — Declaration summary and inline history

- Render honest declaration summaries and progressive details.
- Add cursor history with race-safe loading and focus preservation.
- Add empty, stale, truncated and unavailable/unknown states.
- Gate: component tests, rendered smoke, desktop/mobile/keyboard evidence.

### C4 — Governed policy UI

- Add `viewerCanEditPolicy` to the dedicated policy response.
- Render virtual/default/configured/deny-all states.
- Add owner/admin CAS editor with isolated drafts and explicit conflicts.
- Gate: member/owner/admin integration, UI tests and accessibility review.

### C5 — Assigned diagnostic UI

- Add pool/assigned creation modes and optional required capability.
- Render assignment, claim-time explanation and derived expiry.
- Map deterministic create/claim errors without automatic retry.
- Gate: API/UI integration, unassigned byte compatibility and browser flows.

### C6 — Truth promotion and release

- Promote only capability profiles/reporting from `roadmap` to `real`.
- Remove obsolete S6.B2 copy and pass the prohibited-vocabulary gate.
- Run full unit, runner, migration, preflight, every API integration, build,
  rendered smoke, production audit and Drizzle drift.
- Capture 1440 and 390x844 browser evidence plus keyboard and screen-reader
  semantics.
- Require final Opus review with zero P0/P1 before committing release.

## Rollback boundaries

C0 can be reverted without schema rollback. C1 is a pure refactor and can be
reverted without changing stored data. C2 only adds optional read fields. C3
through C5 are UI/read-authority increments and retain all previous routes. C6
is a label/contract promotion and is reverted atomically if any release gate
fails. No B3.7 commit removes stored history or changes a mutation schema.

## Delivery record

### C5 — Assigned diagnostic UI

> Status: PASS
> Date: 2026-07-26

Pool creation preserves the literal body `"{}"`. Assigned creation sends one
exact request with an active same-tenant identity and an optional capability
from the seven-item closed vocabulary; it never retries or falls back to the
pool. The client gate fails closed while policy is unavailable, when a runner
was removed or when policy disallows the selected capability. Liveness remains
informational rather than admission authority.

Run details render server assignment pins, required capability, admission
basis and server-derived expiry without inventing client status. Independent
request generations protect registry refresh, detail selection and polling
from stale responses. Disabled creation exposes its live reason through
`aria-describedby`.

Fable and Opus both found concurrency/truth defects in intermediate candidates:
poll starvation, stale selection cleanup, policy mismatch, missing gate
conditions and removed-runner presentation. All were closed. The final Opus
delta returned `PASS`, zero P0/P1. At 390x844 the document had equal 390px
client/scroll widths; a clean reload and navigation produced no browser
errors.

### C6 — Truth promotion and release

> Status: PASS
> Date: 2026-07-26

The public registry and UI now promote only `capabilityProfiles` to `real`.
The declaration channel is real, but its content remains visibly
`hostReported` and unverified. Execution, Sandbox and Streaming remain
`roadmap` in the typed contract, repository response, rendered cards and
truth-label gate. The UI consumes the registry capability facts with a frozen
release fallback instead of duplicating unrelated labels.

The first Opus release review returned `FAIL`, zero P0 and one P1 because the
planned prohibited-vocabulary gate was not yet implemented. The final
candidate adds API assertions for identity, heartbeat and all deferred states,
rendered per-card state assertions and a prohibited positive host-claim gate.
The same pass hardened temporal integration tests by renewing before the
`runner_busy` boundary, using a five-second local test lease and waiting from
the server-provided `expiresAt`; production TTL remains unchanged.

Automated release evidence on the final candidate:

- 162 unit tests, 23 runner tests and 22 migration/preflight tests passed;
- all six API integration families passed against isolated local D1;
- typecheck, lint, production build, rendered smoke, production audit with
  zero vulnerabilities and `git diff --check` passed;
- Drizzle reported no schema changes or migration drift;
- 1440px browser evidence showed five `REAL` cards and exactly three
  `ROADMAP` cards with equal client/scroll widths; 390x844 also measured
  equal 390px client/scroll widths;
- existing keyboard focus, permanent live status and `aria-describedby`
  semantics remained covered; C6 changed no interactive element.

The final Opus delta review returned `PASS`, zero P0/P1. Its two non-blocking
P2 hardenings were absorbed before commit: the vocabulary gate now covers
common inflections and overclaim phrases inside capability cards, and a pure
test proves all eight rendered states derive from server-provided registry
facts.
