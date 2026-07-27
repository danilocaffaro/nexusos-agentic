# S6.B4 QA test plan

## B4.1 dark contracts

1. Engine names accept exactly `claude_code_cli` and `codex_cli`.
2. Prompt descriptors contain digest, byte count and opaque reference but no
   prompt content.
3. Job constants are exact: 270000–600000ms server-pinned timeout, 262144
   stdout, 65536 stderr, 1024 decoded excerpt bytes, 20-minute deadline and two
   claims.
4. Receipt parser rejects unknown keys, malformed base64url, decoded excerpts
   over 1024 bytes, bad hashes/sizes and inconsistent truncation.
5. The maximal canonical engine-complete fixture, including maximal ids,
   version, closed summary and both excerpts, is at most 4096 serialized bytes.
6. Fake `ExecutionEngine` maps success, nonzero exit, timeout, cancel and
   adapter throws into closed results.
7. Existing diagnostic claim/completion fixtures remain byte-identical.
8. No route, schema, UI `REAL`, child-process import or spawn is introduced.
8a. Probe parser rejects private/unknown facts, BOM and noncanonical completion
    encodings fail, summaries are closed tokens and the fake retains no input.

## B4.2 inventory and configuration

9. Absolute configured paths may traverse symlinks, but resolved target and
   every path component pass owner/write, regular-file and executable checks.
10. Inherited PATH is rejected; adapter PATH is resolved-engine-dir plus
    `/usr/bin:/bin`.
11. Probe argv is fixed, `shell:false`, bounded and never reports path, HOME,
    account, email, OAuth state or credential.
12. Installed Claude/Codex `--version` and metadata help are bounded and
    version-pinned. Hidden Claude flags prevent help from proving the full
    argv; B4.2 never claims otherwise. A missing supported version or visible
    required token makes readiness `attention_required`.
12a. Exact read-only auth-status commands map raw output in memory to one
     closed result and discard it; missing/malformed/interacting probes are
     a complete `unknown/unknown/engine_probe_failed` result without version,
     never a partially available or guessed-ready result.
13. Signed reports use the engine domain, exact canonical JSON, shared
    declaration nonce service and tenant-bound identity.
13a. Report/config parsers reject BOM-prefixed bytes, so one logical
     declaration has one canonical signed byte representation.
13b. TypeScript and runner mirrors assert the same exact declaration SHA-256;
     non-string versions and numeric/bigint inode identities fail closed.
14. Same nonce/hash replays exact metadata; changed hash is `nonce_reused`.
15. Reports are append-only, bounded/keyset-paginated and GET is pure.
16. `engineFreshnessSeconds` follows policy CAS/history and 3600–2592000
    bounds; `nextReportBy` is `min(12h, freshness/2)`, reports occur on
    debounced probe/config changes and identical early reports are suppressed.
16a. Migration adds current/history engine freshness as `NOT NULL DEFAULT
     86400` with no UPDATE against immutable history; absent policy still
     derives the virtual value.
16b. Prior-release policy writes remain valid at the default engine freshness
     and fail atomically with intact history at a non-default head.
16c. Engine versions with the allowed space/parentheses grammar reach storage;
     invalid grammar and inconsistent readiness evidence fail in triggers.
16d. Policy CAS, immutable version, post-write verification and ledger payload
     hash all bind `engineFreshnessSeconds`.
17. Outbox-v3 has a sibling directory, exact pending and scrubbed terminal
    variants, recovery, quarantine, pruning and duplicate detection. It is
    ignored/preserved by v1/v2 and resumes after re-upgrade.
17a. The B4.2 migration recreates only the two current validators, version
     insert validator and policy ledger validator, proving bounds, equality
     and the new ledger binding.
17b. A pending declaration replaced locally before delivery becomes
     `abandoned`, never `superseded`; every scrubbed v3 terminal state is
     pruned after seven days while legacy abandoned semantics remain frozen.
17c. Backward wall-clock movement cannot invalidate or quarantine frozen v1/v2
     entries; v3 terminal timestamps clamp monotonically to creation time.
17d. Prototype-named declaration kinds are rejected without throwing; recovered
     v3 pending work remains inert while v1/v2 capability and lease flows run.
18. CLI absence leaves every non-engine NexusOS capability functional.

## B4.3 control plane

19. Creation requires active human owner/admin and exact same-tenant active
    assigned runner.
20. Body is incrementally rejected before JSON parsing over 56 KiB; an
    8192-byte prompt with worst valid JSON escaping is still accepted.
21. Prompt validates exact UTF-8 at 1/8192-byte boundaries, is not normalized
    and rejects unmatched surrogates.
22. Equal prompts produce distinct IV/ciphertext and decrypt only with matching
    key id, AAD and tag.
23. Missing/malformed production keyring fails 503 before mutation; local
    fallback works only with `NEXUS_ALLOW_LOCAL_IDENTITY=1`.
24. Rotation uses active key for new rows, preserves old rows and forbids key
    removal while referenced; unknown key fails 503, not erased.
25. Run, encrypted prompt, event and ledger append atomically; rollback leaves
    none.
26. Engine `run.created` accepts exactly engine/digest/byte metadata; plaintext
    never enters event/ledger.
27. Create/list/detail responses never contain the prompt.
28. Diagnostics retain exact route, claim and completion bytes.
28a. Diagnostic claim/completion storage and routes reject engine rows; engine
     claim/prompt/completion use additive paths/domains and reject diagnostic
     rows, including with a downgraded runner.
29. Engine claim never degrades to `assignment_only`; storage requires the
    exact `engine_inventory` lease shape and latest fresh ready report.
29a. Recreated run-insert, run-update, lease-insert and event-insert triggers
     accept each exact engine shape and continue rejecting cross-kind shapes.
29b. Lease-update freezes all pinned engine admission columns; legacy
     admission branches require null engine and expired engine rows are
     immutable.
30. Claim descriptor includes deadline, lease-pinned engine version and prompt
    reference, never prompt content; timeout is clamped with 30-second margin
    and less than 300 seconds remaining is denied.
30a. Claims after deadline, renewals beyond it and late completions fail.
     Scheduled/mutation/local reconciliation atomically ends any lease and
     stores `expired`, immutable deadline operation, event and ledger proof
     under the organization-scoped NexusOS automation principal.
30b. The `run.expired` ledger trigger requires the mapped same-tenant
     automation actor, exact event/deadline operation, expired run and
     canonical run payload reference; repeated sweeps are effect-once.
31. Prompt read requires current tenant, runner, active lease, fence, run and
    reference on every initial/replayed request.
32. Prompt read returns octet-stream plus matching digest/byte/reference headers
    and rejects stale, revoked, canceled, expired, corrupt or erased state.
33. Prompt-read nonce persists only the canonical reference sentinel. A unique
    secret prompt substring appears in none of `runner_lease_nonces`,
    `runner_operations`, `run_events`, `ledger_entries`, logs or errors.
34. Daily scheduled and bounded mutation-time sweeps crypto-shred terminal
    prompt and excerpt ciphertext after 30 days; the idempotent local sweep
    reports overdue retention, no direct destructive route exists and early
    erasure requires `ActionIntent`.

## B4.4 local effect protocol and adapters

35. Prompt reaches only an exclusive 0600 scratch file under the 0700 attempt
    directory and child stdin, never argv, env or process listing; it is
    removed after stdin, on terminal cleanup and during safe crash recovery.
36. Child uses resolved absolute executable, `shell:false`, fresh 0700 cwd and
    the literal environment allow-list.
37. No inherited `NEXUS_*`, Authorization, key, secret or token variable reaches
    child; only operator HOME and adapter PATH are present.
38. Claude argv contains safe mode, literal empty tools/settings/MCP, no
    session, disabled commands/chrome and no bypass; an authenticated benign
    file/shell canary proves no marker access and no tool call.
39. Codex argv disables shell, apps, hooks, goals, multi-agent, plugins, search
    and user config/rules, uses stdin `-`, ephemeral read-only mode and empty
    non-git cwd support.
40. Host customizations covered by the literal flags cannot re-enable a
    tool/MCP/hook; enterprise-managed policy remains disclosed and the canary
    fails readiness if it changes observable tool behavior.
41. Stdout/stderr hashing covers every accepted byte; hard 256/64 KiB bounds
    reject larger receipts and the next byte terminates as
    `output_limit_reached`.
42. Receipt excerpts are base64url, decode to at most 1024 total bytes and the
    maximal body remains within 4096 bytes.
43. Timeout/cancel/revocation/lease-loss sends TERM then KILL and cannot
    complete success.
44. `claimed` can retry; the supervisor immediately-before-exec repeats
    realpath/owner/mode/type/execute/version validation against the
    lease-pinned version, and durable `starting` suppresses a second
    supervisor.
45. Supervisor records own identity before child spawn and child identity
    before writing prompt to stdin.
46. Runner restart monitors a matching live supervisor and consumes its result
    without respawn.
47. Dead supervisor is interrupted only after group absence is proven; pid
    reuse/ambiguous start token blocks new work and never signals another
    process.
48. Result and exact completion enter durable outbox before acknowledgement.
48a. One `nexus-runner serve` process owns the production state lock and
     serializes report, outbox, claim, renew and execute work without lock
     starvation; standalone dry runs cannot acquire or corrupt that state.
49. Server completion replay is byte-identical/effect-once and stale
    fence/revoked/superseded publishers fail.
49a. Engine completion creates an immutable operation-bound engine receipt
     before the run transition; storage requires it for engine rows and
     forbids it for diagnostic completion.
50. Acknowledgement rewrites outbox body to a valid, first-class metadata-only
    v3 acknowledged variant retaining created/updated/status and identity
    envelope fields; parser/recovery/pruning never quarantine or resend it,
    and output/excerpt bytes do not survive seven-day ack retention.
51. Real acceptance for each installed/ready CLI records no credential, path,
    prompt or raw provider error in captured logs.

## B4.5 product release

52. UI requires one active assigned runner and one freshly ready selected
    engine; no fallback/retry.
53. Disabled actions expose a live reason.
54. Detail distinguishes engine, assignment, stored status, derived expiry,
    receipt, truncation and erased content.
55. Copy discloses operator trust, local credentials, provider quota,
    adapter-disabled tools, enterprise-managed policy, 0600 prompt scratch
    persistence under ambiguous process identity and lack of host/network
    isolation.
56. Only one-shot CLI execution becomes `REAL`; Sandbox and Streaming remain
    `ROADMAP`.
57. 1440 and 390x844 have no overflow; keyboard focus and live status are
    deterministic.
58. Full unit, runner, migration, API integration, build, smoke, lint, audit,
    schema drift and prohibited-secret/vocabulary gates pass.
59. Final Opus review returns zero P0/P1.
