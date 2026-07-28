# S8.B3 release evidence

## Discover and frame

S8.B3 tests one reversible hypothesis: NexusOS can combine an explicit B2 CLI
candidate with existing, tenant-scoped S6.B4 inventory and return a bounded
point-in-time host observation without creating provider connectivity.

The architecture gate ran in Claude Code with exact model `claude-fable-5`,
session `9a75329e-5896-42bf-8e1b-658902813ce8`. The final verdict was `GO`,
P0=0 and P1=0.

The implementation base is `main@7325aa3`, containing B4.5, S8.B1 and S8.B2.

## Delivered boundary

The request contains exactly:

```text
runnerId, intent, declaration
```

Validation order is:

1. exact request and runner identifier;
2. internal B2 resolution;
3. explicit CLI-only method gate;
4. exactly one server-side inventory source read;
5. strict bounded `EngineRunOptionsView` validation; and
6. exact runner plus declared-engine selection.

The source runs zero times for invalid request/runner, B2 rejection and OAuth,
and exactly once for a valid CLI request. `RequestIdentity` exists only in the
D1 adapter closure and cannot be supplied through the untrusted request.

Success is `observed` with:

```text
fresh_host_reported_cli_auth_session_for_declared_candidate_no_provider_connection_no_account_no_execution_no_quota
```

The output carries only the declared provider/model/engine binding and the
server-filtered runner/report/freshness/version facts. Trust remains
`declared_unverified` for the binding and `hostReported` for engine evidence.

It never claims connected, authenticated or usable state. It proves no account,
quota, provider behavior, routing or execution.

## D1 integration evidence

The dedicated integration test creates a temporary Worker and D1 database,
imports the B3 D1 adapter directly and applies the real migration history. It
adds no production route. S8.B3.1 appends this program to the existing
`test:integration` script, which CI already executes.

The seeded matrix proves:

- a fresh active target is observed from a truncated view;
- stale evidence returns `engine_report_stale`;
- an inactive runner returns `runner_inactive`;
- a fresh runner in another organization collapses to
  `runner_not_observed`; and
- the 101st runner beyond the 100-runner horizon also collapses to
  `runner_not_observed`.

Each report has both engine evidence rows, so the assertions cross the real
inventory-consistency boundary instead of a fixture-only projection.

## Focused acceptance

The focused B1+B2+B3 matrix passes 47/47 and covers:

- exact version, success/failure claims and the closed reason union;
- observed output minimization, detachment and deep freeze;
- nullable model without implicit selection;
- hostile request records, accessors, symbols and proxies;
- every B2 rejection with closed intent/catalog provenance;
- source call cardinality for invalid, OAuth and valid CLI inputs;
- source throw/rejection propagation without fabricated negative evidence;
- every `EngineRunOptionDisabledReason` passed through exactly;
- absent, cross-tenant and truncated targets;
- duplicate, open, contradictory, sparse and oversized inventory, including
  mixed `evaluatedAt` values in one server snapshot;
- fresh, stale, future and inactive boundaries;
- exact B2 and B3 consumer sets; and
- static exclusion of effects, credentials, `model_connections` and connection
  state.

Candidate gates pass after S8.B3.1: TypeScript, lint, the focused B1+B2+B3
matrix (47/47), the complete unit suite (408/408), all ten official integration
programs including the five-scenario D1 adapter program, production build and
rendered-HTML smoke (2/2). `git diff --check` and the exact four-path micro-lot
allowlist are re-verified on the final commit.

## Exact scope

The nine-path allowlist is:

- new `src/contracts/cli-session-observation.ts`;
- new `src/domain/providers/cli-session-observation.ts`;
- new `src/adapters/d1/cli-session-observation-read-model.ts`;
- new `tests/unit/cli-session-observation.test.ts`;
- new `tests/cli-session-observation-read-model.integration.mjs`;
- new `docs/adr/S8B3-cli-session-observation.md`;
- this release evidence;
- only the B2 consumer gate in
  `tests/unit/connection-intent.test.ts`; and
- one additive Sprint 8 hunk in `docs/PROGRAM-PLAN.md`.

S8.B3.1 is a four-path micro-lot over that candidate: `package.json`, the B3
domain resolver, its unit test and this release evidence. Cumulative S8.B3
scope is ten paths. The only package change appends the existing dedicated B3
integration program to `test:integration`; dependencies and lockfiles are
untouched.

There is no schema, migration, route, UI, ledger, runner or
`model_connections` change.

## Review status

The implementation follows the final Fable consensus. Independent
post-implementation review remains required before promotion. No live provider
or capability `GO` is claimed.

## Rollback and roadmap

Rollback removes the seven new files, restores the B2 consumer gate and removes
the plan hunk. No database or external state can be stranded.

CLI/OAuth execution, provider/account verification, credentials, connection
persistence, assignment, usage, quota, fallback, health, UI and promotion
remain roadmap.
