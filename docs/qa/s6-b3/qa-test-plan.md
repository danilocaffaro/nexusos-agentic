# S6.B3 QA test plan

## Contract, signature and privacy

1. Accept only canonical schema-v1 reports with exact top-level/item keys,
   closed enums, canonical order, no duplicates and a 4 KiB total limit.
2. Bound item count, version bytes and timestamps; reject unknown schema with a
   stable error.
3. Bind domain, runner id, exact pathname, audience, timestamp, nonce and exact
   body bytes in the detached signature.
4. Reject hostname, username, paths, environment, process lists, OAuth state,
   credentials and unknown free-form fields structurally.
5. Prove the server never consumes admission, verification or trust values from
   the runner body.

## Durable idempotency and outbox upgrade

6. Exact nonce replay returns stored bytes; changed bytes under one nonce fail.
7. Retry one report after nonce cleanup and signature skew: stable report id
   returns exact bytes and one semantic row.
8. Same report id with another hash returns `report_conflict`.
9. Compact response bytes after 30 days: the tombstone remains and replay
   returns `410` without a second report.
10. Revoke before nonce or report replay: uniform `403`, no cached success.
11. Load a valid pending outbox-v1 claim and completion with the v2 runner,
    deliver both and never quarantine them.
12. Crash after report persistence, after server commit and before local ack;
    restart converges to one report.
13. A downgraded v1 binary ignores and preserves sibling-directory v2 entries;
    re-upgrade resumes them without quarantine or duplication.

## Append-only storage and read purity

14. Apply every forward migration from empty and from the S6.B2 schema.
15. Reject semantic report mutation, evidence mutation and deletion; allow only
    one-step replay count or response compaction.
16. Reject evidence without its report, cross-tenant runner/report references,
    invalid positions and oversized versions.
17. Derive latest by server receive time rather than host collection time.
18. Call runner/report/policy/run GET routes and prove zero row changes and zero
    new ledger/event entries.
19. Report submission creates no global Decision Ledger entry; a human policy
    change creates exactly one hash-bound `runner_policy.updated`.
20. Report mutation performs bounded oldest-first nonce cleanup and response
    compaction; GET performs neither and a compacted semantic id remains `410`.

## Static probes

21. Static analysis proves probe executable/argv do not depend on HTTP
    responses, policy fields, report bodies or arbitrary operator input.
22. Every probe uses `shell:false`, timeout and bounded output.
23. OS fixtures map deterministic results to closed enums; missing tools,
    securityfs or permissions become `unavailable/unknown`, never `available`.
24. Landlock remains unknown without a real syscall probe; bubblewrap version
    never implies Landlock or containment.
25. Node Permission Model is labeled filesystem guardrail and never sandbox.
26. `--dry-run` performs no network I/O and prints the exact canonical report.
27. All-unknown capability state never blocks enrollment, heartbeat,
    revocation or an unassigned diagnostic.

## Lease convergence and revocation

28. The active-runner unique index is the first migration statement and a
    duplicate-active fixture fails loudly before other schema changes.
29. The operator preflight lists legacy duplicate active leases and
    reconciliation closes them with the existing runner principal plus one
    old-run event per closed lease before migration.
30. A live lease in run A makes the same runner's run-B claim return
    `runner_busy`.
31. An expired lease in A plus claim in B commits one `lease.superseded` in A,
    one `lease.claimed` in B and no partial state; metadata pins old lease,
    runner and fence.
32. Event-head contention rolls the two-run batch back and retries from fresh
    heads.
33. Revocation with one active lease disables principal, revokes lease and
    runner, requeues run, appends event and ledger atomically.
34. Forced residual lease makes revocation return `runner_conflict`, never
    false success.
35. Claim racing revocation has one legal winner and a deterministic
    read-classified loser.

## Assignment and policy admission

36. The existing exact `{}` diagnostic route and response remain unchanged.
37. Assigned creation accepts only an active same-tenant runner and an optional
    closed capability.
38. R2, another tenant and a revoked R1 cannot claim a run assigned to R1.
39. Missing, unknown, unavailable, disallowed or stale declarations fail
    closed with `capability_declaration_mismatch`.
40. A report scheduled every 12 hours remains eligible across the exact
    24-hour default freshness boundary without edge flapping.
41. A fresh allowed declaration admits routing and pins report id/capability in
    the claim event.
42. Revocation between route authentication and lease insert is rejected by
    the storage trigger and classified without permanent retry exhaustion.
43. Assigned runs never fall back; after deadline the read model derives
    expiry and the owner can cancel.
44. Policy compare-and-swap rejects stale edits and preserves tenant/role
    authority.

## UI and regression

45. Per-runner declarations use a distinct `DECLARADO` visual state and the
    complete unverified-host disclosure.
46. Platform `capabilityProfiles` may be real; Sandbox, Execution and Streaming
    remain roadmap in API and UI.
47. No user-facing B3 label says attested, enforced, verified host or sandboxed.
48. Desktop, 390x844 mobile, keyboard and screen-reader flows cover report
    history, staleness, policy explanation and assigned diagnostic errors.
49. GitHub CI runs typecheck, lint, unit, runner, migration, every integration,
    build, rendered smoke, production audit and schema drift.
50. Production audit is clear at the configured severity and Drizzle generates
    no residual migration.
51. Opus performs design, implementation and final release reviews; any P0/P1
    keeps the batch open.

## B3.7 trust-boundary release matrix

52. `npm run dev` applies every pending local D1 migration before starting,
    remains idempotent against an already-migrated state and does not affect
    build or CI startup.
53. Extract one pure declaration-admission oracle and prove the claim path and
    registry projection agree for default, configured and deny-all policies;
    absent, stale, unavailable, unknown and available reports; and the exact
    inclusive freshness boundary.
54. Registry projection is bounded and read-only, records server
    `evaluatedAt`, distinguishes fresh/stale/future/absent/not-evaluated and
    exposes no top-level `eligible` result.
55. Registry policy is returned once per organization, preserves virtual
    version zero versus a configured deny-all and adds no per-runner policy
    query.
56. `DECLARADO` cards distinguish `hostReported` assertions from platform
    `REAL` controls, show authoritative `receivedAt`, label `collectedAt` only
    as host-provided and disclose truncated input as incomplete.
57. No declaration is distinct from an unavailable capability and blocks
    neither identity, heartbeat, revocation nor unassigned diagnostics.
58. Inline report history paginates by the server cursor without duplicate or
    skipped rows, preserves focus, exposes loading/error/empty states and never
    reorders the open runner.
59. Policy read works for every workspace member; only the dedicated
    server-provided permission renders editing controls for owner/admin.
60. Policy drafts are isolated from polling, freeze `expectedVersion` at edit
    start and preserve user input on `policy_version_conflict` without silent
    retry.
61. Virtual default, configured allow-list and configured deny-all are
    visually and semantically distinct; changing policy does not imply that a
    live lease is invalidated.
62. Assigned diagnostics accept an active same-tenant runner and an optional
    closed capability; deterministic create/claim errors are mapped without
    client retries or fallback.
63. Run presentation distinguishes pool from assigned work, required
    capability and `expired · derived`; derived expiry does not replace the
    stored run status and owner cancellation remains available.
64. Desktop 1440 and mobile 390x844 have no horizontal overflow; inline
    details, wrapped chips and forms remain readable with long bounded ids and
    versions.
65. Keyboard traversal reaches every disclosure, history, policy and assigned
    run control; `aria-expanded`, `aria-controls`, focus restoration and
    independent live regions communicate asynchronous changes.
66. A static vocabulary gate and rendered QA reject any B3 label that calls a
    host attested, enforced, verified or sandboxed, and reject `REAL` for
    Sandbox, Execution or Streaming.
67. The final commit promotes only capability profiles/reporting to `REAL`,
    updates API/UI/tests atomically and passes full regression, production
    audit, schema drift, browser evidence and Opus release review.
