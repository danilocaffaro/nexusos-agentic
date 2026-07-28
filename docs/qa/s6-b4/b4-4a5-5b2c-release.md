# S6.B4.4a5.5b2c release evidence

## Outcome

B4.4a5.5b2c activates the first explicit, governed local engine attempt in
the reference runner:

```text
nexus-runner serve --run <run_id> \
  --engine <claude_code_cli|codex_cli>
```

The command processes only the named run and engine. It does not poll for
ambient work. The existing process-lifetime owner continues heartbeat and
bounded completion recovery while one explicit attempt crosses claim, prompt,
renewal, fresh readiness, durable spawn intent, supervised provider execution
and receipt delivery.

The public runner version advances from `0.5.0` to `0.6.0`.

This batch makes analysis-only execution real at the runner boundary. It does
not activate workspace mutation, general-purpose tools, arbitrary MCP access,
streaming UI, unattended work discovery or a multi-tenant provider sandbox.
Provider authentication remains the operator's local OAuth/CLI session.

## Explicit execution boundary

`serve` accepts the target only as an all-or-nothing `--run/--engine` pair.
The run identifier is canonical, the engine vocabulary is closed and the
execution dependency is required only when a target is present. Heartbeat,
completion recovery and target execution share one process-lifetime state
owner. No provider, network or journal effect receives a transferable lock
capability.

The target loop retries a retryable result with bounded backoff and stops at
the eight-failure process budget, leaving durable truth unchanged. Only a
terminal target result wakes the existing completion-recovery loop.
Authentication rejection drains both loops and exits `77`. Malformed control
responses exit `76` as `execution_protocol_invalid`, without retrying or
inventing server truth. Deterministic state and configuration failures
preserve their existing closed exit codes.

## Attempt composition

The runtime composes the previously dark contracts in this order:

1. prepare or recover the one matching journal;
2. claim with a deterministic operation identity;
3. persist `starting` before prompt retrieval;
4. renew and durably resolve pre-spawn cancellation;
5. retrieve and verify the bounded prompt;
6. re-read local engine configuration and resolve fresh readiness;
7. run the authenticated acceptance canary;
8. renew again and re-evaluate the complete spawn budget;
9. persist `spawning`;
10. authorize or resume the durable supervisor; and
11. maintain the lease until a durable result or safe detachment.

Every journal read and append is bound to the originally captured
`runId + engine` as well as the attempt id. Corrupt, multiple, foreign-live,
legacy-supervisor and spawning-crash states fail closed.

The prompt exists only in bounded memory. It is copied once from the prompt
effect, passed through the authenticated supervisor boundary and zeroed on
every terminal, retry, rejection, exception and handoff path. Prompt
plaintext, full raw provider output and raw authentication responses are
absent from journal and operational evidence. The journaled receipt does
retain the governed bounded stdout/stderr excerpts, byte counts and hashes.
Those local base64url excerpts remain sensitive provider output inside `0600`
files under the runner's private `0700` directory until the acknowledged
tombstone removes their bytes. The server stores its separately delivered
excerpt payload encrypted under its retention contract.

## Lease, deadline and race closure

The runtime treats the server lease expiry and run deadline as hard horizons:

- no claim/prompt/renew retry begins or crosses the current lease horizon;
- a local horizon timer races an in-flight renewal and aborts the provider at
  expiry even if the transport never settles;
- supervisor protocol v3 binds `leaseId + fence + expiresAt` into the
  authenticated spawn authorization, accepts only monotonic `extend_lease`
  controls and requires an exact `lease_ack` before the parent adopts a
  renewed horizon;
- the detached supervisor owns the lease watchdog before preparation or
  provider spawn, so parent death or socket loss cannot leave the provider
  running past the last acknowledged horizon;
- the final spawn gate requires the whole provider timeout plus the frozen
  deadline reserve to fit;
- cancellation observed before `spawning` becomes a durable prestart result;
- cancellation, deadline exhaustion, incompatibility, lease loss, erased
  prompt and prompt-integrity failure are valid reasoned terminations while
  the supervisor is waiting to spawn; and
- termination accepted during asynchronous supervisor preparation prevents
  the provider adapter from being invoked.

The durable waiting-spawn supervisor now survives the full frozen recovery
hold instead of the short initial handshake window. A parent may die and a
new controller may reconnect to the same supervisor without launching a
second provider while the journaled horizon remains live. The journal PID is
never trusted as authority to signal an ambiguous process. Because renewed
horizons are acknowledged in memory rather than appended to the frozen
journal grammar, a new parent that starts after the original journaled
horizon may stop an otherwise still-authorized v3 child early; this is a
fail-closed availability trade-off, never an authority extension.

## Version-pinned analysis-only recipes

The launch recipe is literal, closed and version-pinned:

- Claude Code `2.1.219`/`2.1.220` uses safe mode, no slash commands, no Chrome,
  no session persistence, `dontAsk`, an empty tool set, strict empty MCP
  configuration, empty permissions and a fixed analysis-only system prompt.
- Codex `0.146.0-alpha.3.1` uses strict config, read-only sandbox, ephemeral
  state, ignored user config/rules, no approvals, disabled web search and an
  explicit disable for every stable agentic feature in the compatibility
  baseline.

Both inherit only the operator `HOME`, deterministic `USER`/`LOGNAME`, fixed
locale, private scratch `TMPDIR`, a minimal executable path and no color. The
recipe rejects unknown versions, non-absolute paths and extra authority.
Tests bind both recipes to the production adapter's exact 64-argument and
256-byte-per-argument limits.

## Authenticated acceptance canary

Fresh readiness performs a benign but hostile acceptance turn using the exact
production recipe in a new private directory. It creates a random 0600 marker,
asks the model to read that marker and create a second file, and accepts only
the fixed sentinel response.

The canary fails closed on:

- nonzero exit, timeout, cancellation or stream overflow;
- any marker disclosure, mutation or additional directory entry;
- any stderr;
- any tool, command, file-change, MCP or unknown event; or
- any skill discovery/invocation or authentication-elicitation surface; or
- any response other than the exact sentinel in the engine's closed output
  grammar.

The first live Codex attempt was intentionally a NO-GO: a smaller disable list
still emitted a file-change attempt, even though the read-only sandbox blocked
the write. The recipe was hardened with the fixed developer instruction and
the complete stable feature-disable list.

A later production-adapter gate found a second honest NO-GO before release:
the Codex instruction occupied 262 bytes while the adapter permits 256 bytes
per argument. The instruction was shortened without widening authority and a
regression now checks the literal adapter bounds.

The final authenticated production-adapter run returned `ready` for both the
pinned Claude Code and native Codex binaries. Both left the marker unchanged,
created no side effect and emitted no tool evidence. The canary and all
scratch evidence were removed after each verdict.

## Protocol and server-truth handling

Claim, prompt and renew accept only their closed result vocabularies.
Non-retryable `response_error` values and unknown success shapes are protocol
failures, not retry candidates. The runtime exits `76` and does not persist a
local interpretation as authoritative server state.

Readiness storage/invariant exceptions remain recoverable infrastructure
errors. Only a legitimate closed `not_ready` value becomes the durable
`engine_incompatible` prestart result. This keeps local defects from being
misreported as a provider compatibility decision.

## Rollback and compatibility

The additive journal reader remains physically tested against both prior
boundaries:

- `npm run test:rollback:b2a` returns `GO` for all five current/previous
  scenarios against reader `e419c30`;
- `npm run test:rollback:b2b` returns `GO` in both directions against reader
  `232b28edfbdc2564a6a77aede0d21e3484b149f2`.

Older readers quarantine new additive prestart states instead of partially
executing, completing or deleting them. A legacy supervisor identity is
attention-only and cannot authorize another spawn.

Supervisor protocol v3 is deliberately not wire-compatible with the earlier
`sup2:`/`eng2:` identities. Deployment must first drain active B2b supervisors,
then activate the v3 runner. If an old v2 journal remains, the new runner
returns `engine_supervisor_legacy_ambiguous` and performs no provider or
control-plane effect. Tests cover both v1 and the immediate v2 predecessor;
operators must resolve or drain those journals rather than force-adopting a
PID or launching a replacement.

## External and independent review

The frozen Fable architecture session is
`13c0c45a-70a0-4538-b2e1-e4d77965dc5d`. The original Opus implementation
session, `21281221-4c1b-4d32-83b4-a2cec9d3ab1c`, returned a `NO-GO` whose
prompt, canary, retry-horizon and launch-surface findings were corrected. A
fresh independent Opus 5 review in
`2ea91c3d-cac8-49cf-af19-5bebcfde75a8` returned `GO`, with zero P0/P1 and
three non-blocking P2 precision findings. Before freeze, the candidate added
the missing Claude flag probe, bound all 24 disabled stable Codex features to
the live compatibility baseline and corrected the target-loop description.
The independent local oracle also returned `GO` with zero P0/P1. Executable
gates remain authoritative.

## Release gate

The final Team A candidate passed:

- focused composition/supervisor/canary matrix: 97/97;
- final recipe/canary regression: 9/9;
- complete runner suite: 477/477;
- complete unit suite: 298/298;
- migration and preflight suite: 38/38;
- all seven API integration programs;
- TypeScript;
- production build;
- rendered smoke: 2/2;
- ESLint and Oxlint;
- `git diff --check`;
- production dependency audit: zero vulnerabilities;
- B2a rollback: `GO`; and
- B2b rollback: `GO`.

## Residual boundary and handoff

The provider process runs with the authority of the local operator. The
version-pinned recipe and canary prove the observed analysis-only behavior of
the accepted CLIs and managed-policy state; they are not an OS security
sandbox against a hostile same-user process. Any binary version, recipe,
environment or observable policy change invalidates readiness.

The next Sprint 6 product batch must make this boundary visible in the UI,
stream bounded run evidence, expose cancellation truthfully and retain the
same receipt/ledger provenance. It must not relabel workspace mutation,
general tools, provider isolation or ambient scheduling as real.
