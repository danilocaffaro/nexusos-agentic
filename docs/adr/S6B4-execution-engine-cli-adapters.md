# S6.B4 — ExecutionEngine and local CLI adapters

## Status

Accepted for B4.1 after Fable architecture review, the original Opus design
`FAIL` with three P0, a second Fable `PASS`, an Opus delta `FAIL` with zero P0
and three P1, and the final Opus delta `PASS` with P0=0/P1=0. This revision
also absorbs the final optional storage/deployment hardenings before code.

## Decision

NexusOS will reuse Claude Code and Codex as local execution engines behind one
open `ExecutionEngine` port. The control plane owns identity, assignment,
admission, leases, fencing, cancellation, prompt confidentiality and immutable
receipts. An enrolled runner owns provider login, executable validation, a
fresh working directory, process lifecycle and bounded local output capture.

NexusOS will neither fork nor embed either vendor CLI or make one CLI its
orchestration kernel. A new adapter can implement the port, but because engine
names are a closed auditable vocabulary, adding one requires a deliberate
contract, D1 CHECK and UI migration. This preserves an open-source core without
a runtime dependency on Jira, Slack, a paid model API or a vendor-specific
project system.

```ts
type ExecutionEngineName = "claude_code_cli" | "codex_cli";
```

An engine is optional at platform level. Projects, teams, collaboration,
artifacts, governance and diagnostics work with no engine installed. A
specific engine run requires one explicitly assigned active runner that has
freshly declared the selected engine available and locally ready. B4 has no
pool routing, runner fallback or cross-engine fallback.

## Trust boundary

The runner remains `operator_trust`. B4 makes one-shot CLI execution real; it
does not make the host attested or sandboxed.

- Provider OAuth/session credentials stay in the runner host's local credential
  store and are never sent to NexusOS.
- The operator signs in with the vendor CLI outside NexusOS. NexusOS observes
  only a closed readiness state and bounded version.
- The control plane sees the scheduled prompt, encrypts prompt/excerpt payloads
  at rest and never writes plaintext to ledger, event metadata, replay bodies,
  logs or metrics.
- Each CLI needs outbound provider network access. B4 does not claim network
  containment.
- Both adapters disable model-accessible tools through explicit vendor flags.
  Those flags suppress covered host customizations; enterprise-managed policy
  may remain and is checked only by an authenticated canary. This is a launch
  policy, not configuration attestation, OS isolation or remote attestation.
- The selected provider may consume the operator's paid subscription/API quota.
  NexusOS itself requires no paid connector.

The UI must say:

> Execução CLI ocorre no host controlado pelo operador e pode consumir a cota
> do provedor. Credenciais permanecem locais. O adapter desabilita tools e
> customizações por flags explícitas, mas NexusOS não atesta a configuração do
> host nem fornece isolamento de host ou rede. O prompt passa por arquivo local
> 0600 para recuperação de crash; ele é removido após o envio, mas pode
> permanecer bloqueado para inspeção se a identidade de um processo ficar
> ambígua.

## Human creation

The additive route is `POST /api/runs/engine` with exact canonical JSON:

```json
{
  "assignedRunnerId": "rnr_...",
  "engine": "claude_code_cli",
  "prompt": "..."
}
```

Rules:

- active human owner/admin in the same organization;
- exact three keys, with no aliases or nulls;
- request body read incrementally and rejected before JSON parsing over 56 KiB;
  this bound includes the worst valid JSON escaping of an 8192-byte prompt;
- prompt is 1–8192 exact UTF-8 bytes, is not normalized and rejects unmatched
  UTF-16 surrogates before encoding;
- engine is one closed value;
- assigned runner is mandatory, active and same-tenant;
- no automatic retry or fallback;
- neither the 201 response nor run GET/list includes prompt content.

The route uses a new `readBoundedJsonBytes(56 * 1024)` helper that counts the
request stream before decoding or parsing; it does not reuse the existing
unbounded workspace JSON helper. Storage records `kind = 'engine_prompt'` and
the selected engine. Diagnostic rows remain `kind = 'diagnostic'` with a null
engine.

Before the D1 batch, the server encodes exact prompt bytes, computes SHA-256 and
encrypts. One existing transaction/retry boundary then creates the run,
encrypted prompt, `run.created` event and ledger proof atomically. The event
trigger requires exactly `{engine,promptBytes,promptSha256}` for an engine run;
ledger/event metadata never includes content.

Engine runs have a 20-minute deadline and at most two claims. Diagnostics keep
their frozen 15-minute/five-claim constants.

## Prompt cipher and payload lifecycle

Prompt content lives outside the append-only chain in `run_prompts`. A
`PromptCipher` port uses AES-256-GCM with:

- 12 random IV bytes per row;
- AAD `runId|organizationId|promptRef`;
- ciphertext, tag, `cipherVersion = 1` and a closed `keyId`;
- secret binding `NEXUS_PROMPT_CIPHER_KEYS`, a bounded JSON keyring with one
  active key id and at most three 32-byte base64url keys.

Only when `NEXUS_ALLOW_LOCAL_IDENTITY === "1"` may the Worker use a checked-in
development-only keyring. Every other missing/malformed keyring fails closed
as `prompt_cipher_key_unavailable` (503) before mutation. The binding is typed
in `cloudflare-env.d.ts`; no Worker filesystem or chmod assumption exists.

New prompts use only the active key. Old key ids remain decryptable during
rotation. Removing a key is permitted only after a query proves zero live
payloads reference it. An unknown key id, bad tag or AAD mismatch returns 503
and is never reclassified as erasure.

The payload row retains immutable organization/run/reference, digest, exact
byte count, cipher version/key id and timestamps. Ciphertext is mutable only
through the existing governed erasure pattern. B4 adds no direct destructive
route. Automatic retention crypto-shreds terminal prompt and excerpt
ciphertext after 30 days. The Worker runs a bounded daily scheduled sweep and
every mutating engine route opportunistically sweeps at most 25 due rows.
Retention does not depend on Jira or another paid/external scheduler. The
local runtime
exposes the same idempotent bounded sweep as an operator command and reports
`retention_overdue` until it runs. Earlier erasure requires a high-risk
`ActionIntent`. Digest, length and erased time remain.

Plaintext is prohibited from:

- `runs`, `run_events` and `ledger_entries`;
- `runner_operations.response_body`;
- `runner_lease_nonces.response_body`;
- list/detail/create responses, logs, errors and metrics.

## Claim, deadline and prompt fetch

Diagnostic claim request/response bytes remain frozen. `engine_prompt` reuses
the signed-route, fencing and durable semantic-operation services through the
additive `POST /api/runs/:runId/engine-lease/claim`. Its exact body is
`{"engine":"...","operationId":"op_..."}` and its prompt-free job descriptor
is:

```json
{
  "cancelRequested": false,
  "expiresAt": "...",
  "fence": 1,
  "job": {
    "deadlineAt": "...",
    "engine": "claude_code_cli",
    "engineVersion": "2.1.219",
    "outputBounds": {
      "stderrBytes": 65536,
      "stdoutBytes": 262144
    },
    "promptBytes": 120,
    "promptRef": "prm_...",
    "promptSha256": "...",
    "timeoutMs": 600000
  },
  "leaseId": "lse_...",
  "runId": "run_..."
}
```

The claim-time timeout is clamped to:

`min(600000, deadlineAt - serverNow - 30000)`

A remaining budget below 300 seconds denies the claim as
`engine_deadline_insufficient`. The runner applies the same clamp locally.
The server refuses a claim after `deadlineAt`, caps every renewal at that
deadline and rejects completion received after it. A bounded server
reconciler atomically stores an expired terminal state and
`engine_deadline_exhausted` audit proof when no valid completion wins before
the deadline. Thus a disconnect can lose a provider result, but can never
extend execution or turn a late result into success.

The reconciler is realizable storage, not a derived UI fiction. B4.3 creates
one organization-scoped active `automation` principal with external id
`system:deadline-reconciler:v1` for every existing organization and adds it
to future organization provisioning. It also adds immutable
`organization_system_principals` mapping plus immutable
`run_deadline_operations`. Backfill and future provisioning create exactly one
mapped actor; storage triggers prevent its update, revocation or deletion. In
one transaction the reconciler records the operation, ends an active lease
with reason `deadline_exhausted`, changes an engine run from queued/leased to
terminal `expired`, and appends
`run.expired` plus a `run.expired` ledger proof with that automation actor,
deadline and closed reason. `ledger_entries_validate_run_expired` requires the
same organization-scoped mapped automation actor, expired run, matching
deadline operation/event and `nexus://runs/:id` payload reference. Recreated
run triggers make `expired` immutable and allow entry only for
`kind = 'engine_prompt'`, only at/after the stored deadline and only with the
matching immutable operation. The daily Worker scheduled handler,
mutation-time bounded sweep and local idempotent sweep command all invoke the
same repository method.

The production artifact includes an exported `scheduled` handler in
`worker/index.ts`; the deployed inline Worker config in `vite.config.ts` sets
`config.triggers.crons = ["17 3 * * *"]`. Each scheduled or local pass handles
at most 100 rows per payload kind and deadline state. A mutation schedules an
independent, at-most-25-row sweep through `ctx.waitUntil`; it does not share or
roll back the caller transaction. Local development has no scheduler
dependency and uses the same repository method through the operator command;
health remains `retention_overdue` until both retention and deadline sweeps
are current.

Raw prompt is not in the claim because semantic replay stores exact response
bytes for 30 days. Crypto-shredding an encrypted claim was considered and
rejected: it would add per-run keys to the claim replay availability path,
duplicate ciphertext and complicate deterministic response recovery. One
lease-authoritative fetch keeps one erasable payload.

After persisting a retry-safe `claimed` journal record, the runner fetches the
prompt through `POST /api/runs/:runId/prompt` with exact body:

```json
{"fence":1,"leaseId":"lse_...","promptRef":"prm_..."}
```

This route uses a dedicated signed-read wrapper:

1. verify runner, signature, timestamp, nonce, content length and body hash;
2. register nonce/request hash with canonical sentinel response
   `{"promptRef":"prm_..."}`, never prompt bytes;
3. on same-nonce/same-hash replay, re-authorize current facts and re-read the
   payload; on same-nonce/different-hash, return `nonce_reused`;
4. enforce the same current organization, runner, active lease, fence, run,
   prompt reference and non-erased payload on every read.

Replay therefore never resurrects an erased or superseded prompt. The signed
timestamp window remains the existing 60-second past/30-second future bound.
The stored nonce `response_status` describes initial registration only; an
authorized replay may return a later 404/409 after erasure, cancellation or
supersession without mutating that immutable audit row.
The response is `application/octet-stream` with exact UTF-8 bytes plus closed
digest, byte-count and prompt-reference headers. The runner verifies all three
before any spawn. Revoked, canceled, expired, superseded, corrupt and erased
reads fail closed.

## Engine inventory and storage admission

Engine vocabulary remains separate from the seven B3 isolation primitives and
their capability allow-list. Engine reporting reuses the B3 signed-declaration
substrate rather than copying it:

- route `POST /api/runners/:runnerId/engine-reports` and domain
  `nexus-runner-engine-report-v1`;
- the existing physical `runner_capability_nonces` store and shared
  nonce/replay service, with the response containing metadata only;
- one generic outbox-v3 declaration envelope with `declarationKind`, stored in
  a sibling directory so v1/v2 binaries ignore and preserve it on rollback;
- shared canonical/signature/privacy/cleanup helpers;
- separate append-only engine report/evidence tables because the existing B3
  SQL CHECKs are intentionally frozen to isolation primitives.

Reports carry only closed `status`, `readiness`, version and reason facts plus
host collection/server receipt times and truncation. They contain no path,
username, account, email, OAuth state, token, environment value or config-file
name. `ready` means only that a locally safe binary has a supported metadata
version and the pinned read-only auth-status probe observes a usable session.
It does not prove the later prompt argv, tool suppression, provider behavior or
host configuration. Those remain B4.4b fail-closed checks. `ready` is a host
assertion, not attestation.

The closed signature-domain union also gains
`nexus-runner-engine-lease-claim-v1`,
`nexus-runner-engine-prompt-read-v1` and
`nexus-runner-engine-complete-v1`. Diagnostic domains and exact bytes remain
unchanged.

The existing governed admission policy gains non-null
`engineFreshnessSeconds` with the same 3600–2592000 bounds and CAS/history
rules. Both current-policy and version tables use one additive
`INTEGER NOT NULL DEFAULT 86400 CHECK(engine_freshness_seconds BETWEEN 3600
AND 2592000)` column, which backfills existing rows without rebuilding their
foreign-key graph; a truly absent policy retains the same virtual 24-hour
default. The server acknowledges a report with
`nextReportBy`, calculated as
`min(12 hours, engineFreshnessSeconds / 2)`. A runner reports at startup, by
that deadline, and after a debounced change to the local engine
probe/configuration hash. Identical early reports are suppressed locally.

Engine claim admission has a dedicated fail-closed branch. When `runs.engine`
is non-null, only `engine_inventory` is valid. Every legacy admission branch
requires `run.engine IS NULL`; the engine-run insert branch requires a
non-null assigned runner and null isolation capability. Migration adds the
fourth lease shape:

- `admission_basis = 'engine_inventory'`;
- `admission_engine`;
- `admission_engine_report_id`;
- `admission_engine_report_received_at`;
- `admission_engine_version`.

The lease trigger is recreated to require the exact engine, latest report,
freshness, `available`, `ready`, same tenant/runner and no newer report. It
also preserves the one-active-lease constraint. The lease and prompt-free job
descriptor pin the report/version; later inventory changes do not rewrite
active work.

B4.3 explicitly recreates `runs_validate_before_insert`,
`runs_validate_before_update`, `run_leases_validate_before_insert`,
`run_leases_validate_before_update`, `run_events_validate_before_insert` and
the ledger validators. It adds exact engine branches for the
20-minute/two-claim/assigned/null-capability run shape, the four engine
admission columns and `lease.claimed` metadata, plus the system-expiry
transition above. The lease update trigger makes every pinned engine
admission column immutable. No engine row can pass a diagnostic-only branch.

## Local ExecutionEngine port

```ts
interface ExecutionEngine {
  readonly name: ExecutionEngineName;
  probe(): Promise<EngineProbe>;
  execute(input: EngineExecutionInput): Promise<EngineExecutionResult>;
}
```

Input contains prompt bytes/digest, fresh absolute workdir, cancellation
signal, server deadline, server-clamped `timeoutMs` and fixed output bounds. It
contains no server URL, runner key, provider token, configured executable path
or arbitrary argv.

Result contains closed status/reason, exit code, observed version,
stdout/stderr SHA-256 and accepted byte counts, base64url excerpts totaling at
most 1024 decoded bytes, truncation, timestamps and independent timeout/cancel
facts for non-success races. Success requires neither fact to have been
observed; cancel can win after timeout and record both. The adapter hashes
every accepted byte up to hard 256/64 KiB
stdout/stderr limits; the next byte triggers `output_limit_reached` and process
termination without an unbounded buffer. The pure fake keeps only an execution
count, never an input or prompt capture. The port owns no HTTP or lease
behavior.

`EngineExecutionFault` is the degraded pre-output channel only. An adapter may
throw it when it has no output, exit or multi-fact race evidence; after any
such evidence exists it must return the full result. Every returned or
synthesized result crosses the same runtime validator and every adapter
contract violation becomes one sanitized fail-loud `EngineContractError`.

## Executable, environment and literal argv

The operator configures one absolute engine path. The runner resolves symlinks
with `realpath`, validates the target as regular/executable/not setuid or
setgid/not group-or-world writable, validates target ownership as root or the
effective user and verifies that every resolved directory component is owned
by root or that user and is not group-or-world writable. There is deliberately
no sticky-directory exception. A no-follow open plus file-descriptor stat must
match the validated target device and inode before a metadata probe spawns the
resolved path. Only validation outcome and version are reported; the path
never leaves the host.

B4.2 metadata probes are not execution canaries. They use literal,
non-interactive, TTY-less commands with no stdin, a five-second timeout,
16-KiB bounds per stream and TERM/KILL cleanup:

- Claude Code: `--version`, `--help`, `auth status --json`;
- Codex: `--version`, `exec --help`, `features list`, `login status`.

The checked-in compatibility matrix is version-pinned. Visible help tokens are
useful evidence, but a help short-circuit is not authoritative because Claude
Code 2.1.219 exits zero even when an intentionally unknown flag precedes
`--help`. B4.2 never invokes the full prompt argv and never calls a command
that starts login or OAuth. Raw auth stdout/stderr is consumed only by a closed
local decision function and discarded before a probe result exists. If a
pinned auth-status command is missing, malformed, interactive, times out or
cannot be proven read-only, the complete probe collapses to `status =
'unknown'`, `readiness = 'unknown'`, `reason = 'engine_probe_failed'` with no
version, never a partially ready or guessed value. The full argv parse,
authenticated benign-tool canary and provider turn belong exclusively to
B4.4b.

The child environment is built from nothing and includes:

- operator `HOME` for vendor credential lookup;
- adapter-owned fixed `PATH` = resolved executable directory plus
  `/usr/bin:/bin`, never inherited PATH;
- validated `TMPDIR`, `LANG`, `LC_ALL`;
- `TERM=dumb`, `NO_COLOR=1`;
- no `NEXUS_*`, Authorization or inherited key/token/secret variables.

Both adapters use `shell:false`, an empty 0700 workdir, prompt only through
stdin and these version-pinned literal invocations.

Claude Code 2.1.219 baseline:

```text
claude -p --safe-mode --disable-slash-commands --no-chrome
  --no-session-persistence --permission-mode dontAsk --tools ""
  --strict-mcp-config --mcp-config {} --settings {}
  --output-format json
```

Codex CLI 0.145.0 baseline:

```text
codex exec - --strict-config --sandbox read-only --ephemeral
  --ignore-user-config --ignore-rules --skip-git-repo-check --color never
  --json --disable shell_tool --disable apps --disable goals --disable hooks
  --disable multi_agent --disable remote_plugin --disable shell_snapshot
  --config web_search="disabled"
```

Codex `--ignore-user-config` still permits saved authentication but excludes
host config. Shell, apps, hooks, multi-agent, plugins and web search are
explicitly off. Claude safe mode, `--tools ""`, the adapter-owned literal
empty JSON settings/MCP arguments and disabled commands suppress the
customizations covered by those flags. Because provider credentials require
the operator HOME and enterprise-managed policy may still apply, NexusOS does
not claim complete host-configuration isolation. `dontAsk` is defense in depth
only; the adapter does not rely
on undocumented permission-mode behavior to remove tools. Dangerous
permission-skip flags are prohibited. An authenticated acceptance canary asks
the model to use a benign file and shell tool and proves no marker was read or
created and no tool record was emitted. If a required flag disappears, the
canary fails, or help/version is outside the validated compatibility matrix,
readiness becomes `attention_required` and execution fails closed.

The runner renews every 20 seconds. Timeout, cancel, revocation or lease loss
terminates the engine process group with TERM, five-second grace, then KILL.
Server fencing remains final authority.
Renewal keeps the existing cross-kind
`nexus-runner-lease-renew-v1` domain/route. Its expiry is
`min(serverNow + leaseTtl, deadlineAt)`; when that value would not strictly
extend the current expiry the server returns the current lease as a no-op
rather than issuing a forbidden shortening update.

B4.4 introduces one long-lived `nexus-runner serve` process as the only owner
of the state-directory lock. Its internal scheduler serializes outbox
delivery, adaptive/on-change inventory probes, claims, renewals and execution;
standalone commands use the daemon protocol or a distinct dry-run directory
and never contend for the production lock.

## Crash, supervisor and at-most-one spawn

Exactly-once process execution is not derivable across an OS/provider boundary.
The accepted property is at-most-one engine spawn per durable attempt journal,
with possible fail-closed under-execution.

Journal states:

1. `claimed`: persisted/fsynced before prompt fetch; retry-safe and does not
   suppress a later spawn.
2. `starting`: persisted/fsynced with attempt id, lease-pinned engine version
   and prompt digest before launching an adapter-owned supervisor; suppresses
   any second supervisor.
3. `started`: the supervisor records its pid/start token, then spawns the CLI
   in a dedicated process group, records child pid/start token and only then
   writes the prompt to child stdin.
4. `result`: supervisor atomically persists bounded result.
5. `outboxed`: exact completion is durable before local acknowledgement.

If the runner dies, the supervisor may finish and leave a result. On recovery,
the runner validates pid plus process start token before monitoring or killing
the group. A live matching supervisor is not duplicated. A dead supervisor is
classified interrupted only after the process group is proven absent. PID
reuse or ambiguous identity blocks the runner from new work and requires
operator attention; NexusOS neither signals an unrelated process nor publishes
a false interrupted receipt. Because the supervisor records itself before it
spawns the CLI and sends stdin only after child identity is durable, there is
no prompted orphan without a recoverable identity.

The runner creates one prompt scratch file with `O_CREAT|O_EXCL`, mode `0600`,
inside the attempt's `0700` directory only after prompt digest verification.
The supervisor revalidates scratch owner/mode/size/digest, opens it and records
child identity. Immediately before `exec`, it repeats realpath, ownership,
write-mode, regular/executable and version probes and compares the bounded
version to the lease-pinned `engineVersion`; any mismatch deletes the scratch
and returns `engine_incompatible` without an engine-execution spawn; the
bounded version probe itself is a child process. It then streams the scratch
to stdin and unlinks it before waiting for the child. Terminal cleanup removes
it. Crash recovery removes a residual scratch only after a matching live
supervisor/process group is ruled out; ambiguity blocks rather than deleting
state needed by a live attempt.

## Completion and receipt

Diagnostics retain their exact completion route/body.
`POST /api/runs/:runId/engine-complete` accepts exact canonical JSON no larger
than the existing 4096-byte signed limit.

Run-kind guards are bidirectional and enforced in repository queries and
storage triggers: `/complete` and the diagnostic claim route require
`kind = 'diagnostic'` and `engine IS NULL`; engine claim, prompt-read and
`/engine-complete` require `kind = 'engine_prompt'`, a non-null matching
engine and the engine-specific operation/domain. A legacy runner can neither
claim nor complete an engine row, including after downgrade.

To make that bound provable:

- outcome summary is the closed token `completed` or the closed reason itself,
  never provider/free text and at most 64 bytes;
- stdout/stderr excerpts are base64url and total at most 1024 decoded bytes;
- hashes, version, timestamps, exit code, byte counts and closed flags/reason
  are bounded;
- the golden maximal body, including worst allowed values, must serialize to
  at most 4096 bytes.

The parser rejects unknown keys, invalid base64url and inconsistent sizes or
truncation. Excerpts are encrypted in a separate erasable server payload. Full
output stays local. Events/ledger contain receipt digest, sizes, status,
version and reason only.
An excerpt is provider output and may echo prompt content; it is therefore
governed as sensitive payload, never as prompt-free metadata.

Before an engine completion updates the run, the same transaction inserts an
immutable `run_engine_receipts` row keyed by run and operation with engine,
version, receipt digest, bounded sizes/status/reason and excerpt-payload
reference. The run-update trigger requires that row for
`kind = 'engine_prompt'`; the diagnostic completion branch requires that no
engine receipt exists. This is the storage-visible route discriminator.

Completion reuses current-lease assertion, fencing, semantic operation replay
and the one-terminal-outcome invariant. The outbox-v3 pending variant contains
the exact replayable body. After server acknowledgement the runner atomically
replaces it with a first-class acknowledged variant. That variant retains the
base envelope required by shared recovery/pruning: version, declaration kind,
operation id, identity keys, `createdAt`, `updatedAt`, `status = 'acked'`,
request-body digest, response status/digest and acknowledgement time. It
scrubs only request `bodyBase64` and response body bytes. The v3 parser,
sorting and pruning accept both exact variants; an acknowledged item is never
re-sent. Therefore the tombstone is not misclassified as corrupt, is pruned
after seven days and retains no excerpts.

## Failure taxonomy

Closed probe/admission reasons:

- `engine_not_configured`
- `engine_binary_invalid`
- `engine_auth_attention_required`
- `engine_incompatible`
- `engine_probe_failed`
- `engine_deadline_insufficient`

Closed terminal receipt reasons:

- `none` for success only
- `engine_incompatible`
- `engine_deadline_exhausted`
- `prompt_unavailable`
- `prompt_erased`
- `prompt_integrity_mismatch`
- `spawn_failed`
- `timed_out`
- `cancel_requested`
- `lease_lost`
- `output_limit_reached`
- `interrupted_after_start`
- `orphan_identity_ambiguous`
- `engine_exit_nonzero`
- `protocol_invalid`

No error may contain a path, prompt fragment, provider response, account,
environment value or credential hint.

## Delivery batches

### B4.1 — Dark vocabulary, port and golden contracts

- Closed engine/job/probe/result/receipt contracts and pure fake engine.
- Maximal canonical completion-body proof and diagnostic golden bytes.
- No route, schema, probe, UI label, process or child-process import.

### B4.2 — Configuration and signed inventory

- **B4.2a:** dark local configuration/probe core, canonical engine-report and
  acknowledgement contracts, and the complete rollback-safe outbox-v3 base:
  sibling directory, exact pending/scrubbed-terminal variants, parser,
  recovery, pruning and cross-version duplicate scan. No route, migration or
  real process adapter.
- **B4.2b:** shared signed-declaration nonce service, append-only engine
  inventory and governed freshness in one migration. That migration also
  adds current/history engine freshness through `NOT NULL DEFAULT 86400`
  columns without updating frozen history. It recreates only the two current
  policy validators, the version-insert validator and the policy ledger
  validator so the new value is bounded, equal in current/history rows and
  included in the policy ledger hash.
- **B4.2c:** realpath/ownership validation, bounded metadata-only
  compatibility/auth probes and durable v3 engine-report delivery. Capture
  fresh installed `--version`/`--help` and closed auth-readiness evidence.
- Execution remains `roadmap`. B4.2 readiness does not claim the full vendor
  argv or authenticated isolation canary has passed.

### B4.3 — Engine run and encrypted prompt plane

- Additive run/prompt/policy/lease schema and exact event/trigger shapes.
- Worker secret keyring/cipher, bounded creation, scheduled/opportunistic
  retention and organization-scoped deadline automation principal.
- Engine claim descriptor and sentinel-nonce lease-scoped prompt read.
- Bidirectional diagnostic/engine route guards and realizable terminal expiry.
- Fake adapter only; no vendor spawn.

### B4.4a — Supervisor and local effect protocol

- Single-lock `nexus-runner serve` daemon and local command protocol.
- Extend the B4.2 outbox-v3 base with engine-completion declaration kinds;
  do not recreate its directory/parser/recovery/pruning substrate.
- Five-state journal, supervisor/process-group recovery, deadline/cancel kill.
- Bounded hashing/output, outbox-v3 completion and ack scrubbing.
- Fake executable fault/chaos matrix.

### B4.4b — Real vendor adapters

- Literal version-pinned Claude/Codex argv and environment policy.
- Fail-closed compatibility/readiness probes.
- One real local acceptance for each installed/ready CLI.

### B4.5 — Truthful UI and release

- Create/inspect assigned engine work and bounded receipts.
- Show engine readiness separately from host/sandbox trust.
- Disclose local credentials, provider quota, enterprise-managed policy,
  0600 scratch persistence under ambiguous identity and adapter flag boundary.
- Promote only one-shot CLI execution to `real`; Sandbox/Streaming remain
  `roadmap`.
- Full automated, browser and final Opus zero-P0/P1 gates.

## Rejected alternatives

- **Build a new engine:** duplicates mature CLIs and couples orchestration to
  model execution.
- **Use one CLI as the platform kernel:** creates vendor lock-in and gives a
  local process control-plane authority.
- **Plaintext prompt in claim:** leaks into durable semantic replay.
- **Encrypted prompt in claim with per-run crypto-shredding:** removes
  plaintext but duplicates ciphertext/key lifecycle in replay and makes claim
  recovery depend on erasable key state; the lease-scoped read is simpler.
- **CLI names inside B3 isolation capabilities:** falsely mixes tool presence
  with isolation policy.
- **Duplicate the B3 declaration stack:** shared nonce, outbox and policy
  substrates avoid two drift-prone freshness systems; only evidence CHECK
  tables stay separate.
- **Pool/cross-engine fallback:** can send a prompt or cost to an unintended
  host/provider.
- **Inherited environment/config:** risks secret exposure and tool
  re-enablement.
- **Respawn after ambiguous crash:** risks duplicate provider cost/effects.
- **Rely on Codex read-only alone:** the official manual says it is not a
  sufficient secret boundary; explicit tool/config disabling is required.

## Rollback and deferred work

Outbox-v3 lives in a sibling directory ignored by older runners, so downgrade
preserves pending entries and re-upgrade resumes them. Rollback after B4.4
requires draining v3 or keeping the reader; it never quarantines entries as
corrupt.

B4 excludes streaming, multi-turn sessions, repository checkout/workspace
mutation, model routing, OAuth brokerage, approval bridges, tool-enabled
execution and enforceable OS/network sandboxing. B5 owns streaming; B6 owns
disconnect/duplicate/zombie chaos; Sprint 8 owns provider brokerage.
