# S5.B4b QA discovery

## Scope

This gate covers governed cross-artifact head supersession, retraction,
artifact-level cycle safety, target integrity, tenant/role isolation, ledger
atomicity and the Outputs navigation surface.

## Primary risks

1. Version pins are mistaken for graph identity and permit a cycle through a
   different version of the same artifact.
2. A depth limit silently accepts an unproven path.
3. A stale UI supersedes heads the governor did not inspect.
4. A member, viewer, agent, inactive or cross-tenant identity reroutes outputs.
5. The target payload is erased, corrupt or byte-identical to the source.
6. A retraction or ledger collision partially commits.
7. Supersession mutates artifact recency, reviews or frozen decision evidence.
8. The UI hides old content or overstates retraction as guaranteed reversal.

## Architecture evidence

Fable selected the typed relation, owner/admin authority, exact pins, closed
reasons, retract-then-redeclare and no `ActionIntent`. Opus required explicit
artifact-id graph semantics, fail-closed depth exhaustion, equal-hash rejection,
observed-head CAS, honest ledger contention and non-effects on reviews/evidence.

The D1 readiness spike created A→B and B→C in a local Wrangler D1 database and
proved that C→A aborts with `SQLITE_CONSTRAINT_TRIGGER / cycle_detected`, while
the two valid edges remain committed.

