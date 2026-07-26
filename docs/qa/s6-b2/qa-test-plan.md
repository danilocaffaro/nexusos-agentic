# S6.B2 QA test plan

## Domain and migration

1. Apply all migrations from empty and previous schema; assert tables, indexes,
   foreign keys and invariant triggers.
2. Reject two active leases, a fence not equal to generation, mutable
   operational events and inconsistent terminal outcomes.
3. Prove canonical claim, renew and complete bodies and signature strings bind
   domain, runner key id, path, audience, exact body, timestamp and nonce.
4. Exercise lease expiry, renewal, reassignment, cancellation, revocation and
   maximum-claim/deadline boundaries with a controlled clock.

## Atomicity and replay

5. Race claims from two runners: one fence commits and the loser classifies
   without an orphan operation or event.
6. Re-send one nonce with identical and changed signed bytes; exact replay does
   not apply an effect and changed reuse fails.
7. Re-sign one stable operation after deleting nonce rows and advancing beyond
   skew: exact stored response returns and one effect remains.
8. Reuse an operation id with changed path/body/runner: `operation_conflict`.
9. Compact an operation after 30 days: exact bytes disappear, tombstone
   remains, and retry returns `410` without reapplication.
10. Revoke before replay: active-state validation returns uniform `403` and no
    cached success.
11. Reassign after expiry, then submit the older completion: stale fence cannot
    write or replace the newer outcome.

## Runner outbox

12. Crash before persistence: no send and no fabricated outcome.
13. Crash after persistence/before send: restart delivers one outcome.
14. Drop response after commit and restart beyond nonce skew: fresh signature
    plus stable operation id produces one effect and an exact replay.
15. Crash after response/before ack rewrite: restart re-acks safely.
16. Flip one byte in a pending entry: quarantine it, report it and continue
    healthy entries.
17. Leave temporary files: recovery removes them without treating them as
    operations.
18. Start a second process against one state directory: exit 3 before any
    network request.
19. Verify modes, checksum, exact stored body bytes and absence of token,
    private key or provider credentials in every outbox entry.
20. Verify acknowledged pruning at seven days and explicit-only abandoned
    pruning.

## API and product

21. Owner/admin creates/cancels; member/viewer only reads; tenant isolation
    fails closed.
22. A real enrolled runner claims, renews twice and completes the diagnostic;
    detail shows ordered events, fence and replay count.
23. Browser flow creates a diagnostic and provides a non-secret command.
24. Desktop and 390x844 layouts expose current owner/fence, status, outcome and
    the unchanged operator-trust disclosure without overflow.
25. Capability labels say diagnostic leases/replay are real and arbitrary
    execution, sandbox and streaming are roadmap.

## Regression and release

26. Typecheck, unit, runner, migrations, every integration suite, production
    build, rendered smoke, ESLint and production dependency audit pass.
27. Drizzle generation has no residual schema drift.
28. Opus performs adversarial implementation and final release review; every
    P0/P1 is fixed or the batch remains open.
