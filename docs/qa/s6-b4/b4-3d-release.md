# S6.B4.3d release evidence

## Outcome

B4.3d is complete. NexusOS can now grant a signed, evidence-pinned lease for an
encrypted engine run through the exact
`POST /api/runs/:runId/engine-lease/claim` surface. The response is a
prompt-free job descriptor; prompt read, provider execution, engine completion
and deadline reconciliation remain inactive.

## Delivered behavior

- The route reuses the frozen signed-run transport under the distinct
  `nexus-runner-engine-lease-claim-v1` domain and accepts only the canonical
  `engine` plus `operationId` body.
- A separate pure evaluator fails closed on runner activity, tenant, exact
  assignment, selected engine, run state, claim budget, active-lease conflict,
  deadline reserve, policy version and engine inventory.
- Exactly 300 seconds remaining admits with a 270-second execution timeout;
  anything below that boundary returns `engine_deadline_insufficient`.
- Admission has no assignment-only, capability-declaration or cross-engine
  fallback. The latest report must be complete, non-future, fresh, ready,
  available, reason-free and versioned for the selected engine.
- The lease pins policy source/version/freshness, engine, report id/receipt and
  engine version. The canonical effect-once response also pins the bounded
  timeout and opaque prompt metadata.
- Nonce replay precedes semantic operation replay. Operation reuse with
  different signed bytes or runner fails closed.
- One D1 batch supersedes only expired leases, inserts the engine-inventory
  lease and semantic operation, advances the run through the existing trigger,
  appends the exact 11-key `lease.claimed` event and stores the canonical nonce
  response.
- A newer report, policy change, runner change or concurrent claim between
  snapshot and batch is revalidated by storage triggers. The loser
  re-evaluates current facts and cannot fall back.
- Shared renew supports diagnostic and engine leases without changing the
  canonical diagnostic response. Engine renew cannot exceed the run deadline
  or accept a non-strict extension.
- Renew event and nonce inserts are guarded by the exact post-update lease
  state. A zero-row update produces no success, event or replay record.
- Diagnostic claim, cancel and completion mutations now carry explicit
  `kind = 'diagnostic' AND engine IS NULL` storage predicates. Engine rows stay
  invisible to diagnostic list/detail/cancel/claim/complete paths.
- The engine head is tenant-filtered in the initial SELECT and again in the
  evaluator, insert predicate and storage triggers.
- No schema migration, prompt-read route, process spawn, provider credential
  access or UI activation is included.

## Review history

Fable reviewed the existing contracts, repositories and B4.3b triggers before
implementation and returned architecture `GO`, P0=0. It identified one
blueprint/storage mismatch: the closed 11-key event cannot contain the pinned
timeout. The blueprint now records the actual authority correctly: timeout is
pinned in canonical operation/nonce response bytes.

The first Opus 5 implementation review independently reran focused and live
gates and returned `PASS/GO`, P0=0/P1=0/P2=1. Its P2 requested explicit engine
renew boundary coverage. The review also exposed a pre-existing phantom-renew
risk that became relevant once the shared route could reach engine leases.

The candidate was hardened with:

- trigger-level valid, equal and beyond-deadline renewal tests;
- live successful renew counter/event assertions;
- live `engine_deadline_insufficient` denial with unchanged counter, zero
  renewal events and no new nonce;
- guarded renewal event/nonce statements plus exact D1 change-count checks;
- assignment-before-engine denial precedence;
- evidence-sourced engine comparison and SQLite-compatible latest ordering;
- tenant filtering at the engine head query;
- live operation-conflict, concurrent-claim and latest-report-shadow tests;
- a stricter activation/import gate.

The final Opus delta review returned:

- verdict: `PASS`;
- release decision: `GO`;
- P0: 0;
- P1: 0;
- P2: 0.

## Automated evidence

The final candidate passed:

- TypeScript typecheck, ESLint and oxlint;
- 199/199 unit tests;
- 91/91 runner tests;
- 32/32 migration/preflight tests, including real local Wrangler;
- governance/workspace, presence, realtime, artifacts, runner, invalid-keyring
  and runs API integration suites;
- live engine inventory downgrade, successful claim, nonce replay, semantic
  conflict, renewal, cross-kind denial and prompt-free response checks;
- two concurrent claims with exactly one lease, operation and claimed event;
- valid strict renewal plus equal/beyond-deadline storage rejection;
- live deadline-capped renewal denial with no phantom effect;
- Drizzle generation with no schema drift;
- production build and rendered smoke;
- production dependency audit with zero vulnerabilities;
- `git diff --check`.

## Rollback

Remove the additive engine-claim route, pure evaluator and repository wiring,
then restore diagnostic-only renew. No migration is rolled back. Existing
engine leases remain valid, inert forward-schema rows; diagnostics remain
readable and prior binaries continue to reject engine rows.

## Next batch

B4.3e activates only lease-scoped prompt read. The exact signed runner, active
lease, fence, run and opaque reference must be reauthorized on every request
and replay. Plaintext may never enter D1 replay storage, events, ledger,
responses other than the one binary payload, or logs. Provider execution stays
inactive.
