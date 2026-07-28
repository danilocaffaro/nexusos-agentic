# ADR S9.B1b.2a — Workflow-run snapshot integrity

## Status

Accepted as a dark, additive structural projection. It validates state shape
but authenticates and executes nothing.

## Context

S9.B1b.1 introduced the immutable initial snapshot and genesis record. The
first transition-lot draft combined hostile snapshot admission, event identity
and reduction. Once normally formatted with exact terminal invariants, it
measured 426 new production lines and exceeded its 300-line ceiling.

Claude Fable 5 session `c0445304-ff3d-418d-ac16-bc31ebdc5c22` was challenged
with that measurement and rejected both the original lot and an unsafe
two-way split. It approved three durable batches with P0=0 and P1=0:
snapshot integrity, event identity and the final transition reducer. This ADR
covers only the first.

## Decision

`projectRunSnapshot(input)` accepts untrusted input and returns either a
detached, deeply frozen `WorkflowRunSnapshot` or `undefined`. The projection
requires:

1. the exact v1 snapshot keys as enumerable own data properties;
2. the exact state-only specification and claim literals;
3. bounded run, tenant, workflow and definition-hash identifiers;
4. one to sixteen dense, exact and uniquely identified steps;
5. zero to 128 dense, exact and uniquely identified event references;
6. a safe non-negative run version that is not negative zero, equals the
   event-reference count and does not exceed 128;
7. canonical UTC millisecond timestamps whose update time does not precede
   creation; and
8. the exact state shape below.

The closed state shapes are:

- `created`: version zero and every step `pending`;
- `running`: version greater than zero and
  `succeeded* active? pending*`, with at least one non-succeeded step;
- `succeeded`: every step `succeeded`;
- `failed`: `succeeded* failed cancelled*`, with exactly one failed step;
- `cancelled`: `succeeded* cancelled+`.

These shapes preserve ordered, sequential workflow truth without introducing
transition semantics. Correlation between event references and historical
events remains the responsibility of later event-identity and replay batches.

## Security and truth boundary

Objects, nested records and arrays are treated as hostile. Extra or symbol
keys, accessors, non-plain prototypes, sparse arrays, duplicate identities,
invalid descriptors and revoked proxies fail closed. Accessor values are never
read. All reflection is inside a total failure boundary.

An accepted projection proves only that the supplied data has a valid
structural state shape. It does not prove authenticity, authorization,
freshness, provenance, record-chain integrity, idempotency, schedulability or
execution. The existing positive claim remains `state_only_no_execution`.

This lot adds no event payload or hash, transition reducer, replay,
persistence, schema/D1, route, UI, effect, scheduler, provider, secret,
package or program-plan change.

## Dependency and consumer boundary

The new module imports only frozen workflow contracts. Its sole export is
`projectRunSnapshot`, and no production module consumes it in this lot. The
consumer gate is owned by the existing initialization suite so a later,
separately authorized batch can narrow zero consumers to its exact real
consumer without pre-sanction.

The unchanged initialization module remains the sole production evaluator of
raw workflow definitions. It neither imports nor delegates to this projector.
The projector repeats the already frozen v1 identifier patterns and 16-step
bound as private constants. This deliberate self-containment preserves the
exact B1a consumer gate and exports no generic validation API.

## Budget

The promoted base contains 261 production lines across the run contract and
initializer. This lot leaves the 170-line initializer unchanged, grows the
contract from 91 to 92 lines and adds a 292-line projector: 554 total, a net
delta of 293 under the 300-line ceiling.

## Rollback

Revert the S9.B1b.2a commits. This removes the projector, tests and
documentation, removes the maximum-applied-events constant and restores the
central consumer and line gates. There is no data, migration, deployment or
external state to recover.
