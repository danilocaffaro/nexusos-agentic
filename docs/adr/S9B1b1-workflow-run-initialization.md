# ADR S9.B1b.1 — Deterministic workflow-run initialization

## Status

Accepted as a dark, additive state contract. It initializes truth but executes
nothing.

## Context

S9.B1a froze a deterministic workflow-definition projection. A runtime still
needs an initial state and genesis record before later batches can define
transition reduction or replay. The original S9.B1b scope combined all three
concerns and exceeded its small-batch production budget. Architecture review
therefore split it into initialization (this lot), transitions and replay.

Claude Fable session `c0445304-ff3d-418d-ac16-bc31ebdc5c22` and Claude Opus 5
session `f51f8907-4b7d-4c4d-af29-0d9a31363bba` ratified that split and this
contract with no unresolved P0 or P1 finding.

## Decision

`initializeRun` accepts one exact request containing `runId`,
`organizationId`, `projectId`, the raw S9.B1a declaration and a caller-supplied
canonical timestamp. It:

1. snapshots request data through exact own data properties;
2. validates bounded printable-ASCII run and tenant bindings;
3. requires a real UTC instant formatted exactly as
   `YYYY-MM-DDTHH:mm:ss.sssZ`;
4. re-evaluates the raw declaration with S9.B1a;
5. verifies the request tenant equals the normalized definition tenant;
6. uses the S9.B1a projection hash as the only definition-version authority;
7. returns a detached, deeply frozen initial snapshot and genesis record.

The initial snapshot is complete and final for `nexusos.workflow-run.v1`: run,
tenant and workflow bindings; definition hash; version zero; `created` state;
ordered `pending` steps; empty applied-event references; and equal
created/updated timestamps. Terminality is derived from `runState`, not stored
redundantly.

The genesis record has the distinct
`nexusos.workflow-run-record.v1` specification, exact `genesis` type, sequence
zero and the entire initial snapshot. It deliberately has no supplied record
hash, chain link, signature or authenticity claim.

## Determinism and security boundary

The initializer has no clock, randomness, I/O or ambient state. Equal accepted
inputs produce canonically equal outputs. Epoch and pre-epoch instants are
valid when their canonical ISO representation round-trips exactly.

All inputs are untrusted. Extra keys, symbols, accessors, invalid descriptors,
revoked proxies, malformed timestamps, rejected definitions and tenant
mismatches fail closed with a frozen rejection. Unexpected internal failure is
collapsed to `shape_invalid`; no partial state escapes.

The only positive claim is `state_only_no_execution`. This lot adds no
transition reducer, replay, persistence, D1 schema, route, UI, scheduler,
trigger, provider, secret, effect, retry, loop or execution adapter. S9.B1b
remains incomplete until the separately authorized transition and replay lots
land.

## Dependency and consumer boundary

The initializer is the sole production consumer of S9.B1a. Its consumer gate
was narrowed from zero consumers to exactly this module. No package, schema,
release-program or capability-plan declaration changes in this lot.

The production implementation is 261 lines across the contract and domain
module, below the 300-line ceiling.

## Rollback

Revert the S9.B1b.1 commits. This removes both new production modules, the new
unit suite and documentation, and restores the S9.B1a consumer assertion to
zero. No data, migration or external state can be stranded.
