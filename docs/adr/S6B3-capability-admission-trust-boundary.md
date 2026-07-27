# S6.B3 — Host-declared capabilities and policy admission

## Status

Accepted on 2026-07-26 after two Fable architecture passes and two adversarial
Opus reviews. The final design review returned `PASS` with zero P0 findings.
The remaining design P1 items are assigned to explicit batches in
`docs/qa/s6-b3/qa-consensus.md`.

## Decision

S6.B3 makes two capabilities real:

1. an append-only, signed and durably idempotent history of what an enrolled
   host declares about itself; and
2. a server-owned admission decision that may route an assigned diagnostic
   according to a fresh declaration.

It does not make sandbox isolation or arbitrary execution real. A report signed
by the runner proves only that the holder of its private key made an assertion.
It is not remote attestation, host verification or proof that future child
processes will inherit an isolation primitive.

The public vocabulary is therefore:

- `hostReported`: an unverified assertion signed by the runner;
- `eligible`: the server policy currently permits routing;
- `real`: reserved for the capability-report and policy-admission control
  planes themselves;
- `enforced` and `sandboxed`: prohibited as B3 user-facing claims.

The runner remains under `operator_trust`. `sandboxIsolation`, `execution` and
`streaming` remain `roadmap`.

## Product truth

The B3 UI may say:

- "Declarado pelo host — não verificado";
- "Autoteste reportado pelo host — não é prova de isolamento";
- "Elegível pela política do servidor";
- "Declaração ausente, incompatível ou expirada".

It must also say:

> Capability reports are evidence supplied by the operator-controlled host.
> They support routing and diagnostics, not containment. NexusOS does not run
> user work under an enforced sandbox in this version.

No card may place `REAL` next to Sandbox or Execution. The platform registry
adds `capabilityProfiles: "real"` and keeps
`sandboxIsolation: "roadmap"`.

## Threat boundary

The server trusts a valid runner key to identify the reporting machine, not to
tell the truth about that machine. A compromised host can report any
capability. B3 mitigates accidental misconfiguration and makes routing inputs
auditable; it does not defend against a malicious operator or host.

The report contains no hostname, username, filesystem path, environment
variable, process list, credential location, OAuth state, CLI token or provider
account. Evidence uses closed enums, bounded version strings and closed reason
codes.

## Capability report contract

The signed request domain is
`nexus-runner-capability-report-v1`. The route is:

`POST /api/runners/:runnerId/capability-reports`

The path runner id must equal the signing key id. Active-runner validation
occurs before nonce or semantic replay.

The body is canonical JSON, at most 4 KiB and has exactly these top-level
fields:

```json
{
  "capabilities": [
    {
      "capability": "bubblewrap",
      "detection": "binary_version",
      "reasonCode": "none",
      "status": "available",
      "version": "0.11.0"
    }
  ],
  "collectedAt": "2026-07-26T12:00:00.000Z",
  "platform": {
    "arch": "arm64",
    "nodeVersion": "v22.14.0",
    "os": "darwin"
  },
  "reportId": "cap_00000000000000000000000000000000",
  "schemaVersion": 1,
  "truncated": false
}
```

Bounds and closed sets:

- `reportId` is `cap_` plus 32 lowercase hex characters;
- at most 16 capability items, in canonical capability order with no duplicate;
- capability is one of `node_permission_model`, `bubblewrap`, `landlock`,
  `seccomp`, `user_namespace`, `docker` or `podman`;
- status is `available | unavailable | unknown`;
- detection is `node_flag | binary_version | proc_read | syscall | none`;
- `version` is absent or a 1–64 byte token matching
  `[0-9A-Za-z][0-9A-Za-z._+-]*`; probe parsers extract only that token and
  never forward a command's free-form output;
- `platform.nodeVersion` is a canonical bounded Node semver token such as
  `v22.14.0`, never free text;
- reason is `none | not_found | not_supported | permission_denied |
  probe_disabled | unknown`;
- `collectedAt` is untrusted host time; `receivedAt` is authoritative server
  time;
- `truncated=true` is required when a locally collected item did not fit.

The server never accepts an admission decision, verification level or trust
level from this body.

## Cryptographic replay and semantic idempotency

Nonce replay and semantic report idempotency remain separate:

- `runner_capability_nonces` stores the request hash and exact response bytes
  for 15 minutes;
- `(runner_id, report_id)` is the permanent semantic key;
- `request_hash` binds signature domain, runner id, exact pathname and exact
  body bytes;
- the same id and hash returns the exact stored response while bytes remain;
- the same id with another hash returns `409 report_conflict`;
- after 30 days response bytes compact to a permanent tombstone and replay
  returns `410 report_horizon_exceeded`;
- revocation before any replay returns uniform `403 runner_rejected`.

The server applies one report and its evidence items in the same D1 batch. A
lost response cannot duplicate the audit history.

## Crash-safe outbox compatibility

Capability reports use the durable local outbox, but B3 must not invalidate B2
entries.

- readers accept outbox versions 1 and 2;
- writers create version 2 only;
- a pending version-1 `lease.claim` or `run.complete` remains readable and
  deliverable after upgrade;
- version 2 adds `capability.report` and a stable `reportId`;
- version-1 entries remain in `outbox/`; version-2 entries use sibling
  `outbox-v2/`, so a binary rollback ignores rather than quarantines future
  entries and a later upgrade can resume them;
- paths are derived from kind and canonical id, never accepted from network
  input;
- existing version-1 entries transition in place and are never rewritten as
  version 2; recovery never quarantines a valid version-1 entry solely because
  the binary was upgraded.

The capability report is persisted and fsynced before its first network send.

## Append-only storage

B3 uses semantic append-only rows rather than an updatable "latest" cache:

### `runner_capability_reports`

- primary key `(runner_id, report_id)`;
- organization and runner foreign keys;
- request/declaration hashes, platform, runner version, untrusted collected
  time and server received time;
- exact response status/body, replay count and optional compaction time;
- semantic fields are immutable; the update trigger permits only a one-step
  replay-count increment or response-body compaction;
- rows cannot be deleted.

### `runner_capability_evidence`

- primary key `(runner_id, report_id, position)`;
- closed capability/status/detection/reason fields and bounded optional version;
- foreign key to the parent report;
- update and delete are forbidden.

### `runner_capability_nonces`

- primary key `(runner_id, nonce)`;
- exact signed-request hash, response and 15-minute expiry;
- immutable and cleanup-bounded.

Latest declaration is derived by server `received_at DESC, report_id DESC`. A
GET never writes a pointer or reconciles expiry.

Reports are submitted after enrollment, after a declaration hash changes, or
at most once per 12 hours. The default admission freshness is 24 hours, leaving
a full reporting interval of margin; boundary evaluation uses server time and
does not flap at the scheduled report edge. Reports do not enter the
organization Decision Ledger, avoiding global sequence contention. A human
change to admission policy writes `runner_policy.updated`. The immutable report
tables remain the audit history for host assertions.

## Static local probes

`nexus-runner report-capabilities --dry-run` prints the exact canonical body
without network I/O. Without `--dry-run`, it persists and sends the report.

Every probe is a literal allowlisted function in the installed CLI:

- no command, argument, environment value or path is supplied by the server;
- no `shell: true`;
- process executable and argv are fixed by code;
- time, stdout and stderr are bounded;
- output is parsed into closed enums and never forwarded verbatim.

The Node Permission Model is reported only as a trusted-code filesystem
guardrail. Node documents that it is not a security boundary for malicious
code, can be bypassed, and the B3 baseline Node 22 does not restrict network.

`bubblewrap`, Docker and Podman detection reports only that a fixed
`--version` command succeeded. It does not prove a workload used that tool.
`landlock` remains `unknown` because a correct ABI probe needs a syscall helper
that the dependency-free Node runner does not contain. `seccomp` and user
namespace reads describe only the reporting process and kernel configuration.

`sandbox-exec` is never a production capability in B3. Its legacy presence may
be mentioned in operator diagnostics but is not reported as eligible. Apple
App Sandbox requires a signed bundle and entitlements; Windows AppContainer
requires a native helper. Both are deferred.

## Server admission policy

Admission is a pure server-side function of:

- active runner and principal;
- latest report by server receive time;
- report age no greater than the organization policy, default 24 hours;
- policy freshness is bounded to 30 days and evaluated only against a
  canonical server UTC timestamp;
- required capability present with `status=available`;
- capability allowed by the human-owned policy.

Missing, stale, unknown or unavailable declarations fail closed. The result is
named `eligible`, never `enforced`.

The per-organization `runner_admission_policies` row is owner/admin controlled,
versioned with compare-and-swap and writes one metadata-only
`runner_policy.updated` Decision Ledger event. Policy reads are side-effect
free.

An absent row is a virtual version-zero default with a 24-hour freshness
window and the complete closed capability set allowed. This is not a recorded
human decision and is returned as `source=default`; an explicit empty allowed
set is a configured deny-all policy. The first compare-and-swap write expects
version zero and creates version one. Configured freshness is stored as whole
seconds from one hour through 30 days.

An assigned diagnostic without `requiredCapability` uses
`assignment_only`: the assigned runner and its runner principal must be active
in the same organization, but no capability report is required. Capability
freshness, availability and allow-list evaluation run only when the human
explicitly requested a capability.

Each configured policy version has an append-only record containing freshness,
actor and monotonic server time. Allow-list rows reference that immutable
version and do not use JSON membership in a trigger. A version with no
capability rows is an explicit deny-all. Policy head CAS, version record, child
rows and its unguarded per-version ledger entry commit in that order in one
batch; version uniqueness and the policy-ledger trigger make a zero-row CAS
abort rather than relying on application read-back. Once the ledger event
exists, its version rejects further capability inserts.

## Assigned diagnostic runs

The existing `POST /api/runs/diagnostic` contract remains exact `{}`.

A new human route creates an assigned diagnostic:

`POST /api/runs/diagnostic/assigned`

```json
{
  "assignedRunnerId": "rnr_00000000000000000000000000000000",
  "requiredCapability": "bubblewrap"
}
```

`requiredCapability` may be absent. Creation requires an active runner in the
same organization. `runs` gains nullable `assigned_runner_id` and
`required_capability`.

Claim evaluates assignment and admission before constructing a lease, and SQL
triggers repeat the backstop in storage. A run assigned to R1 cannot be claimed
by R2 or another tenant. A revoked, missing, mismatched or declaration-ineligible
runner gets a deterministic error after read-classification, not a generic
retry exhaustion.

`lease.claimed` metadata pins the report id and required capability used by the
admission decision. This is operational evidence of routing, not a sandbox
claim.

Those seven pins are stored first as immutable nullable scalar columns on the
lease, including policy source/version, freshness and report receive time. The
lease trigger validates the exact current policy version and latest report pins
inside the committing transaction. The run-event trigger then null-safely binds
`lease.claimed.metadata_json` to the lease row. Unassigned leases keep every
admission pin null and retain their exact prior event bytes; assignment-only
leases pin only their basis.

Freshness uses integer milliseconds in both JavaScript and SQLite, is inclusive
at the configured boundary and rejects a report received after the claim time.
The lease trigger proves canonical `issued_at` before conversion.
Floating-point Julian-day arithmetic is not used. Lease update validation makes
all seven pins immutable after insert.

An assigned run never falls back to another runner. After its deadline the read
model may derive `expired`; no GET writes an event. An owner can cancel the run.

## One active lease per runner

B3 closes the Sprint 6 debt with:

```sql
CREATE UNIQUE INDEX run_leases_active_runner_uidx
ON run_leases (runner_id)
WHERE "run_leases"."status" = 'active';
```

The index is the first statement of its forward migration. If legacy duplicate
active leases exist, migration fails loudly before any other schema mutation.
The operator reconciliation path must close each older lease and append
`lease.superseded` using that lease runner's existing principal as actor. B3
does not silently update leases without events.

The index would deadlock a runner if an expired lease in run A remained active
while it claimed run B. Therefore claim reads the runner's active-lease head:

- live lease on another run returns `409 runner_busy`;
- expired lease on any run is superseded in the same guarded batch as the new
  claim;
- that batch appends `lease.superseded` to the old run with old lease id,
  runner id and fence, then appends `lease.claimed` to the new run;
- event-head or lease races roll back the entire batch and retry from fresh
  heads.

`runner_busy` is transient: the local claim entry remains pending and retries
with bounded jitter after the operator-visible busy response. It is not marked
rejected, superseded or abandoned merely because another live run currently
owns the runner.

Revocation now sees at most one active lease. It removes the `LIMIT 20` and
closes that lease, appends its event, disables the principal, revokes the runner
and appends the governance entry in one small D1 batch. Post-batch
read-classification must find zero active leases or return
`409 runner_conflict`; it never reports partial success.

The existing lease-insert trigger remains the final claim-versus-revocation
authority. Repository error classification maps a now-inactive runner
deterministically rather than retrying a permanent abort.

## Read purity and expiry

Report and lease freshness are derived in GET responses. No GET writes
`run_events`, capability reports, policy or ledger entries.

Expiry becomes recorded history only during a later mutating transaction such
as claim, cancel, revoke or a new report. There is no scheduler or cron in B3.
The UI distinguishes derived staleness from a recorded transition.

Nonce cleanup and 30-day response compaction are bounded lazy-maintenance
statements executed only inside capability-report mutations. Each statement
uses a deterministic oldest-first limit. A report replay first evaluates its
permanent semantic row, so compaction produces `410` rather than reapplication;
cleanup never runs from a GET.

## API and UI surface

Runner routes:

- `POST /api/runners/:runnerId/capability-reports` — signed report;
- `GET /api/runners/:runnerId/capability-reports` — member, cursor-bounded
  history;
- `GET /api/runners` — adds per-runner `declaredCapabilities`,
  declaration age and `admissionPolicy` result.

Human routes:

- `GET/PUT /api/runner-admission-policy` — member read, owner/admin CAS update;
- `POST /api/runs/diagnostic/assigned` — owner/admin.

`RunnerRegistry.capabilities` remains the platform capability map. The
per-runner field is named `declaredCapabilities` to avoid collision.

The UI adds a visually distinct `DECLARADO` state. Sandbox and Execution remain
`ROADMAP`. Absence of declarations never blocks identity, heartbeat,
revocation or the unassigned B2 diagnostic.

## Small batches

### B3.1 — Pipeline parity and frozen contract

- add `npm run test:runner` to the existing GitHub CI quality job;
- add this ADR and `docs/qa/s6-b3/`;
- freeze capability/outbox v2 parsers, separate rollback-safe storage paths and
  fixtures without activating a report API or changing the current v1 writer.

### B3.2 — Append-only report storage

- forward migration for report, evidence and nonce tables;
- domain parsers, latest derivation and read APIs;
- mutation/update/delete and GET-purity tests.

### B3.3 — Signed report and compatible outbox

- shared signed-runner HTTP adapter;
- active-before-replay, nonce and semantic idempotency;
- outbox v2 writer plus v1 reader and upgrade regression;
- downgrade regression proving a v1 binary ignores and preserves sibling v2
  entries for a later upgrade;
- real CLI report delivery, crash and lost-response tests.

### B3.4 — Static probes

- fixed local probe registry and `--dry-run`;
- privacy/bounds tests and OS parser fixtures;
- GitHub Actions development matrix where free minutes permit; runtime remains
  independent of CI and all-unknown hosts remain usable.

### B3.5 — Lease convergence

- unique active-runner index as a fail-loud first statement;
- an explicit preflight/reconciliation command that lists duplicate active
  leases, closes each through the existing runner principal and appends the
  corresponding old-run event before migration;
- cross-run expired-lease reconciliation in the next claim batch;
- single-batch revocation and zero-residual read-classification;
- runner-busy, claim/revoke and migration preflight chaos tests.

### B3.6 — Assignment and admission

- policy table and governed CAS route;
- assigned-run columns, new strict route, repository guards and trigger
  backstops;
- deterministic read-classification and decision-pinning event metadata.

### B3.7 — Trust-boundary UI and release

- declared-capability history and admission explanation;
- truthful labels/disclosure and derived expiry;
- desktop/mobile/accessibility QA;
- full regression, production audit, schema drift and final Opus release pass.

Every batch is forward-compatible, independently tested and committed before
the next starts. A capability remains hidden or labeled roadmap until its own
batch passes.

## Definition of Done

- CI runs unit, runner, migration, every integration, build, smoke, lint,
  production audit and migration drift gates.
- A valid version-1 pending completion survives a runner upgrade.
- Report retry outside the nonce window creates one report and returns exact
  bytes; conflict, compaction and revocation fail as specified.
- No probe argv derives from a server response or user payload.
- No report contains a forbidden host/credential field.
- A runner can leave an expired lease in run A and atomically claim run B with
  complete events on both runs.
- Revocation cannot return success with a residual active lease.
- Assigned, cross-runner, cross-tenant, stale and unknown-capability claims
  fail deterministically.
- GET routes have zero database side effects.
- UI and API make capability profiles real while Sandbox, Execution and
  Streaming remain roadmap.
- Final Fable/Opus review has zero P0/P1.

## Explicitly deferred

- execution of user work, shell, tool or provider CLI;
- activation of bubblewrap, Landlock, containers or any sandbox provider;
- remote attestation or defense against a malicious operator-controlled host;
- App Sandbox packaging and Windows AppContainer helper;
- network egress enforcement, resource quotas and credential brokering;
- streaming, automatic work polling and multi-run concurrency;
- scheduled expiry reconciliation;
- storage-level immutability of `ledger_entries`, still a pre-GA gate.

## Primary references

- [Node.js Permission Model](https://nodejs.org/api/permissions.html)
- [Linux Landlock userspace API](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html)
- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [Windows AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
