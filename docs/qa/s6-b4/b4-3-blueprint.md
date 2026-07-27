# S6.B4.3 engine control-plane blueprint

> Status: implementation-ready — Fable PASS/GO, P0=0/P1=0
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
- exact recreated run, lease, event, operation and ledger validators.

No route writes the new shape. Prior binaries can keep using the forward schema
because they cannot create engine rows and every diagnostic branch remains
valid. Rollback removes code only; additive storage stays inert.

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
renewals cannot exceed the run deadline. Diagnostic claim/completion adds an
explicit `kind = 'diagnostic'` storage guard, preserving exact successful
bytes.

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
- AAD is exactly `runId|organizationId|promptRef`;
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
receipt time, policy source/version/freshness and pinned timeout. It contains
no prompt reference or content.

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
- the exact runner-operation insert validator needed for deadline operations;
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

