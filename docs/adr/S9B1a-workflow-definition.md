# ADR S9.B1a — Versioned workflow definition

## Status

Accepted as a dark, additive contract. It is not a workflow engine.

## Context

NexusOS needs a deterministic definition vocabulary before storage, triggers,
execution, loops, schedules or HITL can be authorized. Building persistence
first would couple an unfrozen contract to D1 and serialize otherwise
independent work through the migration journal and release scripts.

## Decision

S9.B1a accepts one exact, linear workflow declaration containing a tenant
binding and one to sixteen ordered `agent_task` or `human_task` steps. The
evaluator:

1. snapshots hostile input through exact own data properties;
2. validates bounded identifiers, labels and ordered steps;
3. constructs a normalized definition;
4. hashes only that normalized definition with canonical JSON and SHA-256;
5. returns a detached, deeply frozen projection.

The projection claim is `declared_only_not_schedulable`. Its
`definitionVersionHash` is a content identity, not a publication sequence,
freshness proof or downgrade prevention mechanism. Reordering steps changes the
hash because order is semantic. Object property insertion order does not.

`organizationId`, `projectId` and future foreign identifiers use bounded
printable ASCII without an invented prefix. The storage batch must still
authorize membership and verify real foreign keys. These values remain opaque:
every future HTML, SQL, URL and log consumer must encode them for its output
context rather than treating the accepted punctuation as safe markup.

## Boundary

This batch adds no consumer, route, UI, database, migration, ledger write,
trigger, cron, retry, loop, provider call, effect, secret or scheduler.
Branching and DAG semantics require a new definition spec. Runtime capability
remains `roadmap`.

## Security and failure model

All inputs are untrusted. Extra keys, accessors, symbols, sparse arrays,
duplicate step IDs, unsafe label characters and unbounded collections fail
closed with a frozen rejection reason. Hashing happens only after validation
over locally constructed plain data. The async evaluator never rejects.

Authorization is deliberately absent: a declaration can name a tenant but
cannot prove access to it. A future member-scoped repository/route must perform
that check before persistence.

## Rollback

Remove the five S9.B1a files or revert their additive commit. No data, external
state or consumer can be stranded.
