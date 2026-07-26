# S6.B3.5 lease convergence blueprint

> Architecture gate: Fable `GO-WITH-CONDITIONS`
> Date: 2026-07-26

## Boundary

This batch makes one active lease per runner a storage invariant and makes
runner revocation converge to zero active leases. It does not activate
assignment, capability admission, arbitrary workload execution or new UI
claims. The exact unassigned diagnostic contract remains unchanged.

The batch lands in three independently reversible commits:

1. operator-only duplicate discovery and reconciliation, with no schema or
   request-path behavior change;
2. claim/revoke convergence and runner retry classification on the existing
   schema;
3. the partial unique index plus fail-loud migration proof.

## Deployment choreography

1. Deploy the convergent claim and revoke algorithms before changing schema.
2. Run the lease preflight in list-only mode.
3. Review the opaque identifiers, timestamps, fences and chosen survivors.
4. Run the preflight with explicit `--apply`.
5. Re-run list-only mode and require zero duplicate runners and zero missing
   reconciliation events.
6. Apply migration 0021.
7. Verify the partial unique index exists and the duplicate query remains
   empty.

No migration or request path silently repairs legacy state.

## Operator preflight

The repository-local script invokes the checked-in Wrangler dependency
directly. It is not an HTTP route and therefore has the same operational
authority and audit boundary as D1 migrations. Local mode is the safe default;
remote mode must be explicit and must name an existing Wrangler config.
List-only is always the default. Mutation requires `--apply`.

For each runner with more than one active lease, the survivor is the maximum
tuple:

`(expires_at DESC, issued_at DESC, id DESC)`.

Output is deliberately narrow: runner, lease and run identifiers; fence;
issued/expiry timestamps; and survivor/loser disposition. It emits no
principal names, enrollment material, signatures, capability evidence or
request bodies.

Reconciliation is restart-safe:

1. Phase one changes only losing active leases to `superseded`, with
   `ended_reason = 'preflight_reconciled'`. The existing detach trigger
   requeues their runs.
2. Phase two derives one missing `lease.superseded` event per reconciled lease
   from persisted state, using the runner principal as actor and the lease
   `ended_at` as occurrence time.
3. Event existence is keyed by run, kind and fence. A crash after phase one is
   therefore completed by a later `--apply`; a completed rerun is a no-op.
4. The command exits non-zero if duplicate active runners or missing
   reconciliation events remain.

The selected survivor is never changed by preflight, even when already
expired. The normal claim path owns expiry convergence.

## Claim convergence

Before creating a lease, claim reads at most two active leases for the runner:

- a live lease for another run returns stable `runner_busy` without exposing
  that run id;
- two rows indicate unreconciled legacy state and return `runner_conflict`
  with the operator-preflight remedy;
- one expired foreign lease is superseded in the same D1 batch that appends
  its old-run event and creates the new run lease and event;
- storage conflicts are re-read and classified before any bounded fresh-head
  retry.

Nonce replay remains the first semantic check. A revoked runner or principal
returns `runner_rejected` without consuming retry budget. The reference runner
keeps `runner_busy` and transient claim conflicts pending in its durable
outbox and exits with a retryable status.

## Revoke convergence

Revocation reads at most two active leases. Two rows return
`runner_conflict`; one row is revoked in the same batch that disables the
principal, revokes the runner, requeues the run, appends the lease event,
appends the runner ledger entry and records nonce state where applicable.

Every success path, including already-revoked replay, verifies that the runner
is revoked and its active-lease count is zero. A residual row is closed before
success only when it is the single deterministic row; two rows remain a
fail-loud conflict. Claim/revoke races have legal outcomes in both orders and
never return false success.

## Storage invariant

Migration 0021 contains exactly one statement:

```sql
CREATE UNIQUE INDEX `run_leases_active_runner_uidx`
ON `run_leases` (`runner_id`)
WHERE `status` = 'active';
```

It is generated from the Drizzle schema. If legacy duplicates remain, index
creation fails before any mutation or unrelated schema change.

## Required gates

- list-only byte-preservation and exact survivor ordering;
- phase-one crash followed by phase-two recovery;
- one event per loser, correct actor/metadata and run requeue;
- completed reconciliation rerun is a no-op;
- migration failure on duplicates, unchanged `sqlite_master`, then successful
  apply after reconciliation;
- live-foreign `runner_busy` and durable CLI retry;
- expired-foreign two-run atomic convergence and event-head retry;
- revoke success with zero residual leases and ledger/event atomicity;
- claim/revoke races in both orders;
- exact S6.B2 unassigned diagnostic regressions;
- full CI, audit, schema-drift and independent Opus zero-P0/P1 gate.

## Rollback

The operator script is additive and safe to retain. Before migration 0021, the
claim/revoke commit can be rolled back independently, although deployment
should be paused to avoid recreating duplicates. After migration 0021, older
workers remain schema-compatible but cannot create a second active lease for a
runner; the database rejects it. Dropping the index is not an automatic
rollback action and requires an explicit incident decision.
