# ADR S8.B3 — Dark CLI session observation

- Status: Accepted
- Date: 2026-07-28
- Sprint: 8, batch 3
- Architecture session: `9a75329e-5896-42bf-8e1b-658902813ce8`

## Context

S8.B1 projects a closed provider/model declaration. S8.B2 resolves one
explicit provider/method/engine/model intent to a declared candidate and
deliberately proves no connectivity. Neither boundary can answer the next,
narrower question: did a specific runner recently report a ready CLI
authentication session for the candidate's declared engine?

S6.B4 already exposes the required server-side facts through
`listEngineRunOptions(identity)`. Reprobing a CLI, adding provider I/O or
creating a second inventory model would duplicate authority and enlarge the
trust surface. Treating the existing host report as a provider connection would
overstate what the evidence proves.

## Decision

S8.B3 adds a DARK, point-in-time observation boundary. Its untrusted request has
exactly three own enumerable data fields:

```text
{ runnerId, intent, declaration }
```

The domain resolver validates the request and runner identifier, calls the B2
resolver internally, rejects non-CLI methods, then reads one
`EngineRunOptionsView` through a source closure. It never accepts a caller-made
`ConnectionCandidateProjection`.

The source is not called for an invalid request, invalid runner, rejected B2
intent or OAuth candidate. It is called exactly once for a valid CLI candidate.
The domain source interface contains no identity. The D1 adapter closes over a
server-provided `RequestIdentity` and calls:

```text
listEngineRunOptions(identity)
```

This keeps tenancy and membership authority on the server side without adding
a route.

## Truth contract

The resolution version is:

```text
nexusos.cli-session-observation.v1
```

A successful point-in-time lookup has status `observed` and the literal claim:

```text
fresh_host_reported_cli_auth_session_for_declared_candidate_no_provider_connection_no_account_no_execution_no_quota
```

The candidate projection contains only:

```text
providerId, modelId, cliEngine, bindingTrust=declared_unverified
```

The observation contains only:

```text
runnerId, reportId, receivedAt, freshUntil, evaluatedAt,
engineVersion, trust=hostReported
```

This is host-reported metadata evaluated against server facts at one instant.
It is never a claim that a provider is connected, authenticated or usable. It
does not prove an account, quota, provider behavior, future freshness, routing
or execution.

A failure has status `not_observed` and:

```text
observationClaim=no_cli_session_observation
```

Its closed reasons are request or runner invalidity, B2 rejection,
unsupported method, absent runner observation, and every existing
`EngineRunOptionDisabledReason`. B2 rejection preserves only the closed
`intentReason` and, when applicable, its closed `catalogReason`.

## Inventory validation

The resolver accepts at most the existing 200-option bound. The view, option
arrays and option records must have exact own enumerable data shapes.
Accessors, symbols, sparse or augmented arrays, unknown fields, invalid
identifiers, invalid timestamps, invalid engine facts and contradictory
eligibility fail as `engine_inventory_inconsistent`.

Every runner/engine pair must be unique. Selection is exact on the requested
runner plus B2-declared CLI engine:

- zero matches, including cross-tenant absence and truncation, becomes
  `runner_not_observed`;
- more than one match becomes `engine_inventory_inconsistent`;
- an ineligible option returns its exact closed `disabledReason`; and
- an eligible option becomes `observed` only when the runner is active, trust is
  `hostReported`, status/readiness/reason are `available`/`ready`/`none`, no
  disabled reason exists, version and report identifiers are valid, and
  `receivedAt <= evaluatedAt <= freshUntil`.

No fallback runner, engine, provider or model is selected.

## Privacy and threat model

- Request, view and option reflection is snapshotted once and fails closed.
- Accessor properties are rejected without invoking getters.
- Rejected and observed outputs are detached and deeply frozen.
- The source result is bounded before option traversal.
- Organization ID, runner name, labels, collection metadata, account, email,
  filesystem path, raw output, tokens and credentials are excluded.
- The domain has no ambient identity, database handle, network client or
  process capability.
- Source failures remain infrastructure failures; the resolver does not
  mislabel them as negative host evidence.

## DARK boundary

Exactly the B3 contract and domain are sanctioned B2 consumers. Exactly the D1
read-model adapter consumes the B3 boundary. No route, UI, runner, ledger or
other production module imports it.

The adapter only reads the existing S6.B4 projection. S8.B3 adds no schema,
migration, table, `model_connections` access, persistence or lifecycle
transition.

## Consequences

The product now has a reusable, tenant-scoped observation seam for a future CLI
adapter without executing a CLI or contacting a provider. The result can inform
a later governed decision, but cannot authorize one.

The strict closed view rejects future incompatible changes until the contract
is deliberately versioned. This is preferable to silently accepting new truth
semantics.

## Rollback

Rollback removes the seven additive B3 files, restores the B2 consumer gate and
removes the single Sprint 8 plan hunk. No persisted or external state can be
stranded.

## Remains roadmap

- CLI process execution and reprobes;
- OAuth observation and execution;
- provider connectivity and account verification;
- credentials and encrypted references;
- agent assignment, budgets, usage and quota;
- fallback and semantic-degradation events;
- health, expiry and reconnection UX;
- routes, UI and capability-label promotion; and
- any write to `model_connections`.
