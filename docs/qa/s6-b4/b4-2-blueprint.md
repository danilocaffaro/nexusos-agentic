# S6.B4.2 configuration and signed inventory blueprint

> Status: Fable PASS — P0=0/P1=0, GO for B4.2a
> Capability truth: execution remains `roadmap`

## Outcome

An enrolled runner can safely describe whether each optional local CLI is
configured, metadata-compatible and authenticated without sending a path,
identity, credential or raw provider output to NexusOS. The control plane can
later retain signed, append-only inventory and govern its freshness. No engine
prompt can be created, claimed or executed in B4.2.

NexusOS projects, teams, collaboration, governance, artifacts and diagnostics
remain fully usable when neither CLI is installed, configured, authenticated
or reachable.

## Internal build order

### B4.2a — dark contracts and pure probe core

- Strict local `engines.json` v1 contract with zero to two closed engine names
  and absolute local paths. The file is later enforced as a real 0600
  non-symlink; no path is serializable into a report.
- Injected filesystem/process interfaces and a deterministic probe state
  machine. B4.2a uses fake ports only and imports no child-process API.
- Canonical engine report and acknowledgement parsers mirrored in TypeScript
  and runner JavaScript, with exact keys, fixed engine order and a 4096-byte
  bound.
- Complete dark outbox-v3 base in sibling `outbox-v3`: exact pending and
  scrubbed terminal variants, recovery, quarantine, pruning and duplicate
  scans across v1/v2/v3. No runtime command writes an engine report yet.

Rollback: revert one schema-free, route-free commit.

### B4.2b — signed server inventory

- One migration for append-only engine report/evidence rows and additive
  `engine_freshness_seconds` current/history values.
- Recreate all policy validation/history triggers so the new field is bounded
  and identical across the current row and immutable version row.
- Generalize the signed declaration nonce/replay service while freezing every
  existing B3 capability-report request, response, error and side effect.
- Add signed engine report POST, pure keyset history GET and exact
  `{nextReportBy,receivedAt,reportId}` acknowledgement.
- Change the exact policy parser, route, UI and tests atomically to include
  engine freshness.

Rollback: the server remains backward compatible with runners that never send
engine reports; the additive column has a 24-hour default. Migration rollback
is tested from the prior release and does not enable engine claims.

### B4.2c — real local probes and delivery

- Real filesystem adapter validates resolved path, target inode, ownership,
  execute permission, unsafe write bits, setuid/setgid and every directory
  component on macOS/Linux.
- Real process adapter runs only the pinned metadata/auth commands without a
  shell, stdin or TTY, using five-second and 16-KiB-per-stream bounds and
  process-group cleanup.
- Auth output is interpreted in bounded memory and discarded before any
  `EngineProbe` exists. An indeterminate auth probe collapses the complete
  result to `unknown/unknown/engine_probe_failed` without version.
- Local configuration commands and v3 report delivery use the runner's single
  state lock. Identical early declarations are suppressed using a local-only
  canonical hash that may include path facts but never leaves the host.
- Downgrade preserves v3; re-upgrade resumes pending delivery.

Rollback: older runners ignore the sibling v3 directory. Pending entries
remain intact and are resumed only by a v3-aware binary.

## Exact B4.2a contracts

The local configuration is canonical JSON:

```json
{
  "engines": {
    "claude_code_cli": {
      "executablePath": "/absolute/local/path"
    }
  },
  "schemaVersion": 1
}
```

Unknown engines, fields, relative paths, NUL/newline characters, dot segments,
duplicate separators and payloads over 4096 bytes are invalid. An empty
`engines` object is valid and means no optional provider is configured.

Every signed report is a full two-engine snapshot in fixed order:

```json
{
  "collectedAt": "2026-07-26T12:00:00.000Z",
  "engines": [
    {
      "engine": "claude_code_cli",
      "readiness": "attention_required",
      "reason": "engine_not_configured",
      "status": "unavailable"
    },
    {
      "engine": "codex_cli",
      "readiness": "ready",
      "reason": "none",
      "status": "available",
      "version": "codex-cli 0.145.0"
    }
  ],
  "reportId": "egr_00000000000000000000000000000000",
  "schemaVersion": 1,
  "truncated": false
}
```

`ready` means only safe local binary + supported metadata version + closed
read-only auth status. It is not host attestation, sandbox proof or proof that
the future prompt argv is safe.

The canonical 201 acknowledgement is:

```json
{
  "nextReportBy": "2026-07-27T00:00:00.000Z",
  "receivedAt": "2026-07-26T12:00:00.000Z",
  "reportId": "egr_00000000000000000000000000000000"
}
```

Outbox-v3 pending retains the exact signed body. Every terminal state
`acked`, `rejected`, `superseded` or `abandoned` is a first-class tombstone
that retains identity, timestamps and request/response digests but removes
request and response bytes. `abandoned` has null response status/digest; the
other terminal states require both. A pending report replaced locally before
delivery becomes `abandoned`, not `superseded`. Every scrubbed v3 terminal is
pruned after seven days; the legacy v1/v2 abandoned retention rule remains
unchanged.

## Injected port boundary

The pure core receives:

- filesystem facts from `realpath`, no-follow open/file-descriptor stat and
  per-component lstat;
- effective uid, effective gid and supplementary groups;
- a bounded process result containing only exit, timeout, overflow and bounded
  byte buffers.

It returns only a closed `EngineProbe` and a local-only change fingerprint.
The real adapters land in B4.2c. Platform errors and provider text never become
error messages.

## B4.2a Definition of Ready

- Fable re-review returns zero P0/P1 on this blueprint and corrected ADR.
- Golden report, acknowledgement and v3 variants are fixed before code.
- Failure examples include unsafe path component, unsupported metadata version,
  malformed auth status, v3 scrubbed tombstone and v1/v2 downgrade preservation.
- Migration and route scope are explicitly empty.

## B4.2a Definition of Done

- New runtime logic is fake-port-driven; static inspection proves no new route,
  migration, UI `real` label or child-process import.
- TypeScript and runner report parsers accept one byte-identical golden fixture
  and reject noncanonical/private/unknown facts.
- Maximal report and acknowledgement fit the 4096-byte signed transport.
- V1/v2 fixtures remain byte-identical; v3 recovery, quarantine, scrubbed
  terminals, pruning and duplicate detection pass.
- Typecheck, unit, runner, migration, integration, build, smoke, lint, audit,
  schema drift and `git diff --check` are green.
- Opus implementation review returns zero P0/P1 before release.

## Explicitly prohibited in B4.2

- Engine run route/schema, prompts, encryption, claims, leases, completion,
  deadline/retention sweep, supervisor, journal or scratch files.
- Full Claude/Codex prompt argv, provider turn, model output or login flow.
- PATH lookup, inherited environment, shell invocation or unbounded output.
- Server retention of path, HOME, username, email, organization, OAuth state,
  token, config filename, raw auth output or vendor free-text error.
- Promotion of one-shot execution, Sandbox or Streaming from `roadmap`.
