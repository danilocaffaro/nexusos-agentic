# S6.B4.3 engine control-plane blueprint

> Status: B4.3g, B4.4a1 and B4.4a2 complete; B4.4a3 pending
> Capability truth: execution, sandbox and streaming remain `roadmap`

## Outcome

B4.3 adds the server-side control plane for one assigned, version-pinned local
engine run. An active human owner/admin can create an engine run with an
encrypted prompt; the exact assigned runner can claim it only from a latest,
fresh, ready engine inventory; and that lease can fetch the exact prompt
through a separately signed, lease-authoritative read. The server records
deadline expiry and prompt retention as real effect-once state.

B4.3 never starts Claude Code, Codex or any provider process. Provider login,
credentials and model quota remain on the operator runner. Diagnostics,
projects, teams, collaboration, artifacts and governance continue to work
without either CLI or any paid/external connector.

## Frozen compatibility boundary

The following surfaces do not change:

- diagnostic create, assigned-create, claim, renew, complete and cancel paths;
- diagnostic canonical request/response fixtures and signature domains;
- diagnostic 15-minute deadline, five claims and admission shapes;
- capability and engine report paths, report schemas and append-only history;
- outbox v1/v2/v3 behavior and prior-runner preservation;
- `ExecutionEngine` result, bounds and receipt contracts from B4.1;
- product truth: Execution, Sandbox and Streaming stay `roadmap`.

Every engine surface is additive. Legacy admission branches require
`runs.engine IS NULL`; engine admission requires `engine_inventory`.
Diagnostic routes reject engine rows and engine routes reject diagnostic rows,
including calls from a downgraded runner.

## Small-batch delivery order

### B4.3a — dark cipher, prompt and HTTP contracts

Schema-free and route-free pure foundations:

- strict engine-create parser with exact keys
  `assignedRunnerId`, `engine`, `prompt`;
- exact prompt validation: valid UTF-16 input, 1–8192 UTF-8 bytes, no
  normalization and unmatched-surrogate rejection;
- an incremental request-stream reader that rejects above 56 KiB before JSON
  parsing, independent of `Content-Length`;
- `PromptCipher` port and Web Crypto AES-256-GCM adapter;
- strict `NEXUS_PROMPT_CIPHER_KEYS` parser with one active key and at most
  three unique 32-byte base64url keys;
- exact AAD builder: UTF-8 `runId|organizationId|promptRef`;
- opaque `prm_` reference, prompt-read body/sentinel and engine-claim body
  parsers;
- canonical prompt-free claim descriptor and golden fixtures.

No production code imports these contracts. Rollback is one schema-free,
route-free commit.

Release result: complete. The full pipeline passed with 191 unit, 91 runner
and 24 migration tests plus every API integration suite, production build,
smoke, zero production audit vulnerabilities and no schema drift. The final
Opus delta returned `PASS/GO`, P0=0/P1=0.

### B4.3b — forward-only dark storage

One additive migration:

- `runs.kind = 'engine_prompt'`, nullable selected `engine`, terminal
  `status = 'expired'`;
- `run_prompts` encrypted payload rows with immutable provenance and one-way
  crypto-shred;
- `run_leases.admission_basis = 'engine_inventory'` plus immutable
  engine/report/version/freshness pins;
- `run_events.kind = 'run.expired'`;
- organization-scoped automation principal mapping and immutable deadline
  operations;
- mapped system principals remain internal and are excluded from presence,
  work-assignee and collaboration-member resolution;
- exact recreated run, lease, event, operation and ledger validators.

No route writes the new shape. Prior binaries can keep using the forward schema
because they cannot create engine rows and every diagnostic branch remains
valid. Rollback removes code only; additive storage stays inert.

Release result: complete. The final candidate passed 192 unit and 32 migration
tests, all affected API integrations, schema-drift, typecheck, lint, build,
smoke, production audit and diff-hygiene gates. The final Opus review returned
`PASS/GO`, P0=0/P1=0 after proving that internal system principals are excluded
at every collaboration/work/presence resolution path and by a database
backstop, without hiding ordinary automation or agent principals.

### B4.3c — encrypted creation

Activate only `POST /api/runs/engine`:

- active same-tenant human owner/admin;
- active same-tenant assigned runner;
- exact bounded body and prompt parsing;
- production keyring failure returns
  `prompt_cipher_key_unavailable` (503) before any D1 statement;
- local development fallback exists only when
  `NEXUS_ALLOW_LOCAL_IDENTITY === "1"`;
- one atomic batch creates the run, encrypted prompt, `run.created` event and
  ledger entry;
- create/list/detail return metadata only.

No UI invokes the route until B4.5. Reverting the route leaves encrypted rows
readable after re-upgrade and leaves diagnostics unaffected.

Release result: complete. The exact create route now resolves a valid keyring
before D1, encrypts under the frozen AAD and atomically stores the engine run,
prompt, event and Decision Ledger proof. Its exact 201 response contains
metadata only, and diagnostic routes cannot observe or mutate engine rows. The
final Opus delta review returned `PASS/GO`, P0=0/P1=0/P2=0 after independently
verifying the success/failure secret sentinels, concurrent ledger-chain
continuity, response contract and exact activation allowlist.

### B4.3d — engine claim and deadline-aware shared mutations

Activate `POST /api/runs/:runId/engine-lease/claim`:

- exact canonical body `{"engine":"...","operationId":"op_..."}`;
- exact assigned runner and engine;
- latest same-tenant report at claim time;
- selected evidence is `available`, `ready`, versioned and fresh under the
  governed engine-freshness policy;
- no `assignment_only`, capability or cross-engine fallback;
- one lease pins engine, version, report, receipt time, policy/freshness and
  timeout;
- timeout is `min(600000, deadlineAt - serverNow - 30000)`;
- less than 300 seconds remaining denies
  `engine_deadline_insufficient`;
- response is the frozen nested prompt-free job descriptor.

The shared renew and cancel implementations gain kind-aware guards. Engine
renewals cannot exceed the run deadline; a deadline-capped renewal that cannot
strictly extend the current lease returns `engine_deadline_insufficient`.
Diagnostic claim/completion adds an explicit `kind = 'diagnostic'` storage
guard, preserving exact successful bytes.

Release result: complete. The assigned runner can claim only the exact engine
from the latest complete, fresh, ready and versioned inventory, with all
evidence pinned in one atomic, replay-safe lease transition. Shared renew is
kind-aware, deadline-bounded and emits no event, nonce or success when its
guarded update affects zero rows. Diagnostic success bytes remain frozen and
every cross-kind probe fails closed. The final Opus delta review returned
`PASS/GO`, P0=0/P1=0/P2=0.

### B4.3e — lease-scoped prompt read

Activate `POST /api/runs/:runId/prompt` under
`nexus-runner-engine-prompt-read-v1`:

- exact canonical body
  `{"fence":1,"leaseId":"lse_...","promptRef":"prm_..."}`;
- signature, timestamp, nonce, content length and body hash are verified;
- initial nonce registration stores only canonical
  `{"promptRef":"prm_..."}`;
- same nonce/same request reauthorizes every current fact and re-reads;
- same nonce/different request returns `nonce_reused`;
- tenant, runner, active lease, fence, leased run, reference and non-erased
  payload must match on every read;
- success is exact `application/octet-stream` UTF-8 bytes plus closed
  reference, digest and byte-count headers.

The wrapper is additive; the existing JSON replay wrapper remains frozen.

Release result: complete. The assigned runner can now read the exact prompt
bytes only while its signed engine lease, fence, assignment, tenant and opaque
reference remain current. Initial authorization is committed as a prompt-free
sentinel before decryption; replay is write-free and reauthorizes every
current fact. Closed binary headers disclose only the prompt metadata already
pinned in the claim descriptor. Wrong tenant/runner/lease/fence/reference,
revoked, canceled, expired, corrupt and cross-kind cases fail closed without
plaintext. The final Opus delta review returned `PASS/GO`, P0=0/P1=0.

### B4.3f — realizable deadline expiry

Add the organization-scoped system actor and effect-once reconciler:

- exactly one active `automation` principal with external id
  `system:deadline-reconciler:v1` for every organization;
- immutable organization-to-system-principal mapping;
- deterministic immutable deadline operation per run;
- one transaction ends any active lease with `deadline_exhausted`, changes a
  queued/leased engine run to immutable `expired`, and appends the exact
  `run.expired` event and ledger proof;
- concurrent/repeated sweeps are effect-once;
- post-deadline claim, renewal and completion cannot win;
- a Worker scheduled handler, mutation-time `ctx.waitUntil` and local operator
  command invoke the same repository operation.

Scheduled/local passes process at most 100 deadline rows. Mutation-time work
processes at most 25 independently of the caller transaction.

Release result: complete. Due queued and leased engine runs now converge
effect-once to immutable `expired` state through the mapped organization
automation actor. A leased transition inserts the immutable operation first,
revokes the exact active fence, relies on the pinned synchronous detach trigger
for `leased -> queued`, then records the terminal run, event and hash-chained
ledger proof in the same D1 batch. Cron, authenticated mutation-time
`waitUntil` and a loopback-only local operator invoke the same bounded
repository operation. Mutation passes run only after a successful authoritative
operation, with one in flight per isolate and a 30-second cooldown. Health
reports reconciliation overdue after the frozen grace window. No provider
execution, completion or prompt erasure is active.

### B4.3g — prompt retention and release

- terminal prompt ciphertext crypto-shreds after 30 days;
- digest, exact byte count, reference and erased timestamp remain;
- scheduled/local passes process at most 100 rows per payload kind;
- mutation-time work processes at most 25 rows;
- no direct destructive route exists;
- earlier erasure remains a governed high-risk `ActionIntent`;
- health reports retention/deadline reconciliation overdue until local
  operators run the idempotent command where no scheduler exists;
- full secret-sentinel, schema, integration, build, smoke, audit and Opus
  release gates pass.

The excerpt-retention branch is table-driven but remains empty until B4.4
introduces encrypted engine receipts.

Release candidate: terminal `completed`, `canceled` and `expired` engine
prompts become eligible at the exact inclusive boundary
`observedAt - recordedAt >= 2592000000`. The authoritative terminal
`recorded_at`, rather than the original deadline, starts the retention clock;
therefore a delayed deadline sweep retains ciphertext longer, never shorter.
One guarded update clears only key id, IV, ciphertext and authentication tag,
then records `erased_at`. Prompt reference, SHA-256, exact byte count, creation
provenance, events and ledger entries remain immutable. The existing prompt
row and its one-way database transition are the effect-once identity, so no
new event, ledger kind, operation table or migration is introduced.

The every-minute Worker cron, literal-loopback local command and the existing
post-success mutation hook invoke bounded deadline and retention maintenance
under one per-isolate in-flight guard and 30-second cooldown. Retention does
not import, resolve or decrypt with the prompt keyring; unavailable or retired
keys cannot block shredding, and shredded rows leave the live-key index.
Health exposes only `promptRetention.overdue` after the same ten-minute
operational grace. There is no direct prompt-erasure route. The storage guard
intentionally defers governed erasure before 30 days to a future migration and
high-risk `ActionIntent`.

Fable returned architecture `GO`, P0=0/P1=0. The release closes the
B4.3f test-depth debt with a live 100-row poisoned backlog: the coherent run
is processed first, the response reports truncation plus 99 isolated failures,
and the successful effect remains committed. A forced retention-trigger abort
also returns the closed failure and HTTP 503, then converges after the fault is
removed. The final Opus review and post-hardening delta review both returned
`PASS/GO`, P0=0/P1=0.

### B4.4a1 — dark receipt and excerpt storage

Migration 0026 introduces one immutable engine receipt and one encrypted,
one-way-erasable excerpt payload per engine run. The future transaction order
is operation tombstone, excerpt, receipt and run update. Storage pins the
current active/unexpired lease, fence, selected engine/version, operation,
deadline and the frozen execution-result consistency matrix.

Stdout and stderr excerpts share one authenticated frame with a two-byte
stdout-length prefix and at most 1024 provider-output bytes. AES-GCM AAD uses
the opaque `exc_` reference, so prompt/excerpt substitution fails. The
retention and live-key queries cover both protected payload kinds.

The run-update trigger now requires the matching receipt for an engine
completion and forbids a receipt on diagnostic completion. Event and ledger
completion validators remain byte-identical and diagnostic-only, there is no
engine-completion route, and no runner or Worker writes either table.
Execution therefore remains `roadmap`.

Release candidate: Fable returned architecture `GO`; 215 unit, 91 runner and
37 migration/storage tests pass together with all seven live API integration
suites, build, smoke, typecheck/lint, schema no-drift, production audit and
diff hygiene. Opus returned `PASS/GO`, P0=0/P1=0 after the Fable arbitration
and hardening delta. See `b4-4a1-release.md`.

### B4.4a2 — signed atomic engine completion

Activate the server-side completion boundary under the frozen
`nexus-runner-engine-complete-v1` domain. Nonce and semantic operation replay
run before lazy keyring resolution, so an acknowledged completion remains
replayable during a later key outage.

The single D1 batch records operation, encrypted excerpt, immutable receipt,
terminal run, released lease, exact event pair, nonce/liveness and
hash-chained ledger proof. Migration 0027 changes only the engine-aware
`run.completed` event and ledger validator branches; every diagnostic branch
is preserved. The receipt digest includes the independent `timedOut` and
`cancelRequested` race facts.

Release result: complete. The full pipeline passed with 216 unit, 91 runner
and 38 migration/storage/preflight tests, all seven API integrations, build,
smoke, lint, zero-vulnerability production audit and no schema drift. Final
Opus review returned `PASS/GO`, P0=0/P1=0. No runner caller or provider spawn
is active; execution remains `roadmap`. See `b4-4a2-release.md`.

## Exact control-plane contracts

### Creation

Route:

```text
POST /api/runs/engine
```

Exact JSON:

```json
{
  "assignedRunnerId": "rnr_00000000000000000000000000000000",
  "engine": "claude_code_cli",
  "prompt": "..."
}
```

The run stores:

- `kind = 'engine_prompt'`;
- selected closed engine;
- mandatory assigned runner and null isolation capability;
- 20-minute immutable deadline;
- two maximum claims;
- no prompt plaintext.

`run.created` metadata is exactly:

```json
{
  "engine": "claude_code_cli",
  "promptBytes": 120,
  "promptSha256": "..."
}
```

The prompt reference and ciphertext provenance live only in `run_prompts`;
they are not added to event or ledger metadata.

The 201 response is metadata-only and exact:

```json
{
  "run": {
    "id": "run_00000000000000000000000000000000",
    "organizationId": "org-example",
    "requestedBy": "principal-example",
    "kind": "engine_prompt",
    "engine": "claude_code_cli",
    "status": "queued",
    "version": 1,
    "leaseGeneration": 0,
    "claimCount": 0,
    "maxClaims": 2,
    "deadlineAt": "2026-07-27T12:20:00.000Z",
    "assignedRunnerId": "rnr_00000000000000000000000000000000",
    "promptRef": "prm_00000000000000000000000000000000",
    "promptSha256": "...",
    "promptBytes": 120,
    "createdAt": "2026-07-27T12:00:00.000Z",
    "updatedAt": "2026-07-27T12:00:00.000Z"
  },
  "events": [
    {
      "sequence": 1,
      "kind": "run.created",
      "actorId": "principal-example",
      "occurredAt": "2026-07-27T12:00:00.000Z",
      "metadata": {
        "engine": "claude_code_cli",
        "promptBytes": 120,
        "promptSha256": "..."
      }
    }
  ]
}
```

The response contains no prompt plaintext, cipher key id, IV, ciphertext or
authentication tag. The opaque prompt reference and digest grant no read
authority; B4.3e still requires the exact signed runner, active lease and
fence.

### Prompt cipher

The production binding is `NEXUS_PROMPT_CIPHER_KEYS`. Its JSON grammar is
versioned, bounded and canonical:

```json
{
  "activeKeyId": "key-2026-07",
  "keys": {
    "key-2026-06": "<43-character base64url key>",
    "key-2026-07": "<43-character base64url key>"
  },
  "schemaVersion": 1
}
```

Rules:

- one to three keys;
- key ids are closed bounded non-secret identifiers;
- every value canonically decodes to exactly 32 bytes;
- `activeKeyId` must name one member;
- encryption always uses the active key;
- each row gets an independent random 12-byte IV;
- AAD is exactly `runId|organizationId|payloadRef`, with a closed `prm_` or
  `exc_` reference;
- unknown stored key, bad tag, invalid IV or AAD mismatch is availability/
  integrity failure (503), never erasure;
- a key cannot be removed while any live prompt/excerpt row references it.

The checked-in development-only key is reachable solely with explicit local
identity opt-in. Tests run with injected keys and never print key material.

### Engine claim

Route and signed domain:

```text
POST /api/runs/:runId/engine-lease/claim
nexus-runner-engine-lease-claim-v1
```

Exact body:

```json
{
  "engine": "claude_code_cli",
  "operationId": "op_00000000000000000000000000000000"
}
```

Canonical success:

```json
{
  "cancelRequested": false,
  "expiresAt": "2026-07-27T12:01:00.000Z",
  "fence": 1,
  "job": {
    "deadlineAt": "2026-07-27T12:20:00.000Z",
    "engine": "claude_code_cli",
    "engineVersion": "2.1.219",
    "outputBounds": {
      "stderrBytes": 65536,
      "stdoutBytes": 262144
    },
    "promptBytes": 120,
    "promptRef": "prm_00000000000000000000000000000000",
    "promptSha256": "...",
    "timeoutMs": 600000
  },
  "leaseId": "lse_00000000000000000000000000000000",
  "runId": "run_00000000000000000000000000000000"
}
```

`lease.claimed` metadata is a separate exact storage grammar. It binds
operation, assignment, admission basis, selected engine/version, report id and
receipt time and policy source/version/freshness. The pinned timeout lives in
the canonical effect-once operation/nonce response bytes; the closed 11-key
event grammar contains no timeout, prompt reference or content.

### Prompt read

Route and signed domain:

```text
POST /api/runs/:runId/prompt
nexus-runner-engine-prompt-read-v1
```

Exact body:

```json
{
  "fence": 1,
  "leaseId": "lse_00000000000000000000000000000000",
  "promptRef": "prm_00000000000000000000000000000000"
}
```

Nonce storage persists only:

```json
{
  "promptRef": "prm_00000000000000000000000000000000"
}
```

The response body is never replay storage. Replays reauthorize and decrypt the
current row. Cancellation, expiration, lease loss, revocation, corruption or
crypto-shred changes the later response to a closed denial without mutating
the immutable initial nonce record.

## Storage and transaction authority

### Engine creation transaction

Before D1: parse keyring, parse/encode exact prompt, compute SHA-256, generate
run/prompt ids and IV, encrypt with context-bound AAD.

One D1 batch:

1. insert exact engine run;
2. insert encrypted `run_prompts` row;
3. insert sequence-one `run.created`;
4. append the next organization ledger entry.

Any trigger, foreign-key or ledger-sequence failure rolls back all four. A
ledger conflict retries with the same logical ids/ciphertext but a newly
calculated ledger predecessor.

### Claim transaction

Read-side evaluation provides useful closed errors; storage remains the
authority. The lease insert trigger rechecks assignment, runner activity,
latest report, engine evidence, version, readiness, freshness, deadline and
one-active-lease constraints inside the mutation. A newer report or
concurrent claim makes the batch fail and retry/re-evaluate.

Nonce replay precedes semantic-operation replay. A successful claim batch
inserts the lease and operation, advances the run/fence/count, appends the
event and stores prompt-free canonical response bytes.

### Prompt-read registration and replay

Nonce insertion is guarded by an in-statement existence check for every
current authorization fact. The payload is decrypted only after the guard has
committed. On replay the sentinel is compared, all facts are rechecked and the
payload is read again. No plaintext crosses a D1 statement.

### Expiry transaction

The immutable deadline operation id is deterministic from the run id.
Principal/mapping existence, lease ending, run transition, deadline operation,
event and ledger append occur atomically. Guarded status/deadline predicates,
operation identity, event sequence and the ledger duplicate validator make
concurrent sweep attempts effect-once.

### Retention transaction

Keyset-select at most the configured bound, then perform one-way guarded
updates from live ciphertext to null plus `erased_at`. Repeated sweeps are
no-ops. Unknown keys and corrupt payloads are never reclassified as erased.

## Migration shape

The migration recreates the current validators rather than layering
order-dependent triggers:

- `runs_validate_before_insert`;
- `runs_validate_before_update`;
- `run_leases_validate_before_insert`;
- `run_leases_validate_before_update`;
- `run_events_validate_before_insert`;
- the exact deadline-operation insert validator;
- run-event ledger validation plus a dedicated `run.expired` validator.

New storage primitives:

- `runs.engine`;
- engine variants for `runs.kind/status`;
- `run_prompts`;
- pinned engine admission columns on `run_leases`;
- `organization_system_principals`;
- `run_deadline_operations`;
- exact indexes for due deadline rows, due terminal prompt retention and live
  key references.

Every new table has same-tenant composite foreign keys or equivalent trigger
checks, exact identifier/value/byte bounds, immutable provenance, delete
denial and only the explicitly documented one-way transition.

## QA gates

### B4.3a

- prompt parser at 0/1/8192/8193 bytes;
- unmatched surrogate rejection and NFC/NFD non-normalization;
- incremental body overflow with truthful, false and absent content length;
- worst-valid JSON escaping at 8192 prompt bytes below 56 KiB;
- canonical keyring grammar, one/three/four keys and active-key membership;
- equal plaintext produces different IV/ciphertext;
- wrong key, key id, tag and every AAD component fail;
- exact claim, descriptor, fetch and sentinel goldens;
- static gate proves no schema, route or production import.

### B4.3b

- immediate migration and all-migrations `sqlite_master` checks;
- valid diagnostic rows remain valid;
- every engine/diagnostic cross-kind row, lease and event is rejected;
- latest/fresh/ready engine report is storage-enforced;
- every pinned lease column is immutable;
- expired rows and system mappings/operations are immutable;
- prompt ciphertext permits only the one-way shred;
- migration rollback compatibility is exercised by a prior-runner fixture.

### B4.3c–e

- 503 keyring failures leave zero run/prompt/event/ledger rows;
- four-row creation rollback and ledger-conflict retry;
- prompt absent from create/list/detail/error/log bytes;
- no assignment-only fallback and no stale/non-latest/non-ready inventory;
- timeout at the exact 300-second boundary and below it;
- frozen diagnostic golden bytes;
- prompt read rejects wrong tenant/runner/lease/fence/ref and revoked,
  canceled, expired, superseded, corrupt or erased state;
- replay stores and returns no plaintext.

### B4.3f–g

- claims after deadline, renewal beyond deadline and late completion reject;
- queued and leased expiry both produce one operation/event/ledger proof;
- concurrent and repeated sweeps are effect-once;
- exact same-tenant mapped automation actor is required;
- retention boundaries immediately before/at/after 30 days;
- scheduled, local and mutation bounds are exact;
- no direct erasure route;
- a unique high-entropy prompt sentinel is absent from
  `runner_lease_nonces`, `runner_operations`, `run_events`, `ledger_entries`,
  responses, captured logs and errors;
- lint, typecheck, unit, runner, migration, API integration, production build,
  rendered smoke, Drizzle no-drift, production audit and `git diff --check`;
- final Opus review: P0=0/P1=0.

## Definition of Done

B4.3 is complete only when criteria 19–34 in the S6.B4 QA plan pass, all
diagnostic golden bytes remain exact, the scheduled/local/mutation reconcilers
are real and bounded, the secret-sentinel scan is clean, and Opus returns
P0=0/P1=0. At that point the server control plane is real but local execution
still remains `roadmap` until B4.4.
