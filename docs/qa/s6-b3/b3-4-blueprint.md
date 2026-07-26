# S6.B3.4 static capability probe blueprint

> Architecture gate: Fable `GO-WITH-CONDITIONS`
> Date: 2026-07-26

## Boundary

This batch replaces the deliberately all-unknown B3.3 production baseline
with bounded local self-probes in the reference runner. It does not change the
signed report protocol, server storage, admission policy, assignment,
execution, sandboxing, API projections or UI labels.

Every result remains an unverified `hostReported` declaration. Tool presence
is not containment. The Node Permission Model is a filesystem guardrail, not a
sandbox. User-namespace sysctls describe host configuration and do not prove
that a later unprivileged namespace creation will survive AppArmor or another
host policy.

## Invariants

1. Probe executable candidates, argv and proc sources are frozen code
   constants. HTTP responses, policies, report bodies, CLI arguments and
   operator environment values cannot alter them.
2. Child processes use absolute paths, `shell:false`, empty environments,
   ignored stdin, private pipes, a 3-second deadline and a 16 KiB cap per
   stream. POSIX children run in a private process group so timeout or overflow
   kills descendants; a final bounded resolver prevents inherited pipes from
   hanging collection.
   Independent probes run concurrently and return in canonical order, bounding
   aggregate collection near one deadline rather than four sequential ones.
3. Proc reads use exact absolute sources and bounded buffers: 8 KiB for
   `/proc/self/status`, 64 bytes for integer knobs.
4. `available` requires exit zero plus a strict version parse, an exact Node
   flag result, or an exact bounded proc-field match. Ambiguity, overflow,
   timeout and malformed output become `unknown`.
5. Raw stdout, stderr, paths, environment, username and hostname never enter
   the report, outbox or logs. Only closed enums and digits-and-dots version
   captures are emitted.
6. Landlock has no executable, argv or source and stays
   `unknown/none/probe_disabled`. Bubblewrap never changes Landlock, seccomp
   or namespace evidence.
7. Docker and Podman stay `unknown/probe_disabled` on unprobed operating
   systems such as Windows. The runner never claims they are structurally
   unavailable there.
8. Missing fixed binaries become `unavailable/not_found`; a present
   non-executable binary becomes `unavailable/permission_denied`; unexpected
   filesystem or process failures become `unknown`. A candidate writable by
   group/world or owned by neither root nor the runner user is not executed.
9. `--dry-run` may run local probes but still creates no runner state and makes
   no network request. Existing fsync-before-send and byte-identical crash
   replay remain unchanged.
10. `NEXUS_RUNNER_DISABLE_PROBES=1` is a reduce-only operational escape hatch
    that emits the former all-unknown baseline. Test-root injection is rejected
    outside explicit test mode.

## Frozen matrix

| Capability | Supported probe | Positive signal | Fail-closed behavior |
| --- | --- | --- | --- |
| `node_permission_model` | runner `process.execPath --permission -e process.exit(0)` | exit 0; report `process.version` | exit 9 is unsupported; other failures unknown |
| `bubblewrap` | Linux fixed `/usr/bin` or `/usr/local/bin` candidate, `--version` | exact `bubblewrap N.N[.N.N]` | missing/permission/unknown closed mapping |
| `landlock` | none | never | always unknown and probe-disabled |
| `seccomp` | Linux bounded `/proc/self/status` | exact `Seccomp: 0..2` field | absent field unsupported; read ambiguity unknown |
| `user_namespace` | Linux bounded max and unprivileged-clone sysctls | maximum greater than zero and optional clone knob nonzero | either zero unavailable; missing/invalid maximum unknown |
| `docker` | Linux/macOS fixed candidates, client-only `--version` | exact `Docker version N.N.N, build HEX` | unprobed OS unknown, not false unavailable |
| `podman` | Linux/macOS fixed candidates, client-only `--version` | exact `podman version N.N.N` | unprobed OS unknown, not false unavailable |

Candidate paths intentionally exclude `PATH` lookup and exotic install
locations. Reduced detection coverage is preferable to executing a
user-selected path. Version commands never contact Docker or Podman daemons.

## Small-batch module shape

- `runner/capability-probes.mjs` owns the frozen matrix, bounded process/file
  adapters and canonical seven-item collection.
- `runner/nexus-runner.mjs` owns test-mode gating, the reduce-only escape hatch,
  report identity/time/platform and durable delivery. CLI version becomes
  `0.4.0`.
- `tests/runner-capability-probes.test.mjs` supplies deterministic fake roots
  and hostile subprocesses without changing production candidates. Injected
  roots must live below the operating-system temporary directory.
- Existing CLI and domain tests prove the probed canonical body crosses the
  production parser, survives both crash boundaries and leaks no hostile
  marker into the report or outbox.

The domain protocol, outbox formats, server routes, database schema,
migrations, contracts and UI must not change in this batch.

## Required gates

- frozen-spec static analysis and no-shell child hygiene;
- strict good/malformed/oversized/nonzero/timeout/permission cases;
- descendant-kill and hard wall-clock bound;
- Linux proc matrix and user-namespace dual-knob guard;
- cross-OS honesty and unconditional Landlock independence;
- hostile privacy marker absent from dry-run, signed request and decoded
  outbox body;
- forbidden test-root injection and conservative-disable behavior;
- production runner output accepted by the production report parser;
- crash-after-persist and crash-after-send convergence with probed bytes;
- full typecheck, lint, unit, runner, migration, integration, build, smoke,
  audit and schema-drift gates;
- independent Opus implementation review with zero P0/P1.

## Rollback

The batch is runner-only and keeps schema-v1 reports plus outbox-v2 unchanged.
Reverting to runner 0.3.0 merely produces a new all-unknown declaration hash;
append-only history accepts it and old v2 entries remain readable. No database
or control-plane rollback is required.
