# S6.B4.4a5.4 release evidence

## Outcome

B4.4a5.4 adds the first public, long-running runner command:

```text
nexus-runner serve [--server URL] [--state-dir PATH] [--interval-seconds 10..300]
```

The command owns one process-lifetime filesystem lock and runs two independent
single-flight loops: signed heartbeat and bounded engine-completion recovery.
It activates only the effect-only `runEngineRecoveryCycle` boundary accepted
in B4.4a5.3. It does not claim work, read prompts, start a supervisor, spawn a
provider CLI or expand credential access. Arbitrary execution therefore
remains `roadmap`.

## Architecture

The serve command acquires one opaque ownership capability, loads the enrolled
runner context once and starts both loops under one abort controller.
Heartbeat can borrow the runner's ordinary identity state while recovery
prepares and finalizes under the state-lock borrow. Completion HTTP runs
outside that borrow, so a slow response cannot starve heartbeat.

Recovery is deliberately narrow:

1. invoke only `runEngineRecoveryCycle`;
2. deliver each already-durable `engine.complete` intent serially;
3. yield between nonterminal effects so shutdown can stop the remaining plan;
4. re-enter the borrow for fresh durable validation and settlement; and
5. wait for an in-flight HTTP response or its request deadline before release.

The legacy combined coordinator facades remain dark and nonactivatable. They
are not imported by the public CLI or serve command.

## Bounded HTTP effect

`createEngineCompletionHttpEffect` is a total adapter around the existing
injected signed-request function. Before network access it validates the
canonical syntax and closed shape of the attempt ID, operation ID, run ID,
pending-entry checksum, pathname, signature domain, body bytes and body
SHA-256. The fresh post-effect borrow remains responsible for comparing those
commitments with the exact durable pending entry and prepared recovery plan.
Invalid or hostile inputs produce a closed protocol artifact; they do not
throw or call the network.

Native response bodies are copied directly into one fixed 64 KiB scratch
buffer. The adapter permits at most 1,024 reads, validates an optional
canonical `Content-Length`, cancels early or hostile streams and never builds
an unbounded chunk array. Transport and stream failures become retryable
artifacts. Replay is true only when `x-nexus-replay` is exactly `1`; the real
HTTP status is preserved.

The effect receives only the frozen request descriptor plus a narrowly scoped
completion context. It receives no state directory, lock capability, claim,
prompt, supervisor or provider surface.

## Failure and shutdown policy

Each loop owns an independent consecutive-failure counter. A successful loop
iteration resets only that loop's counter. Retry uses full-jitter exponential
backoff, bounded away from zero and capped at 60 seconds. Eight consecutive
failures stop the process instead of busy-looping.

Signals stop new network work through a tested pre-effect check, allow an in-flight
completion request to finish or expire, durably classify that response, abort
the remaining recovery plan at its next nonterminal yield and await both
loops. A terminal halt completes its durable recovery report before shutdown
instead of yielding first. Ownership is released exactly once. Release failure
is not retried, returns `stale_possible` and cannot downgrade a more severe
exit reason.

Stop reasons have an explicit precedence independent of arrival order:

- durable completion authentication rejection: exit 77, highest precedence,
  retain the lock/pid file as durable operator evidence;
- ordinary fatal authentication failure, including heartbeat: exit 77 and
  release normally;
- deterministic usage/configuration/local-contract failures: exits 64, 66 or
  78;
- unexpected failure: exit 1;
- temporary I/O or exhausted failure budget: exits 74 or 75; and
- clean signal-driven drain: exit 0.

The distinct precedence for durable rejection closes the race in which a
heartbeat rejection arrives before an in-flight completion is durably rejected.
The next owner can recover the intentionally stale pid file through the
existing lock protocol after the recorded PID is no longer live. PID reuse
fails closed as `runner_already_running` and requires operator verification
rather than guessing that a live PID is stale.

## Automated acceptance

The focused matrix covers:

- one process lock with concurrently progressing heartbeat and recovery;
- heartbeat progress during sixteen slow completion effects;
- the real public CLI crossing the effect-only cycle and settling a durable
  journal/outbox completion exactly once;
- signal arrival during native completion HTTP;
- clean shutdown, stale pid recovery and `SIGKILL` recovery;
- heartbeat authentication release versus durable completion-auth retention;
- both arrival orders for competing stop reasons, including the 77-by-77 race;
- independent failure counters, reset behavior, eight-failure budget and
  bounded full-jitter backoff;
- deterministic delay-failure selection and containment before ownership
  release;
- a pending stop preventing the injected completion effect from being called;
- actionable auth and configuration diagnostics without a generic safe-stop
  fallback;
- release failure without retry;
- exact response length, overflow, read-count, cancellation and hostile native
  stream behavior;
- envelope/body/path/domain/checksum drift before the network boundary;
- strict command option validation; and
- absence of claim, prompt, provider spawn, secret output and legacy
  coordinator activation.

The final focused gate passes 139/139 with repository lint and diff hygiene.
Static review additionally confirms that every closed state/ownership fatal
reason maps to operator-actionable text; those defensively unreachable
branches are not presented as executable coverage.

## Review gate

Fable selected the two-loop, single-owner design and the effect-only recovery
boundary. It required the fixed scratch buffer, independent failure budgets,
deadline-aware drain, explicit exit codes and durable-auth retention rule.
The exact architecture session was
`07a44daf-d9d8-42fa-a505-6aeec6310bb5` using only
`claude-fable-5`.

The independent test oracle initially returned HOLD for missing race,
identifier/checksum and permanent-stop proof. After those closures it found a
same-exit-code race between heartbeat auth and durable completion auth. The
reason-aware priority fix and deterministic 77-by-77 test closed the final
finding; the oracle returned GO with P0=0/P1=0 and 20/20 relevant tests.

The first exact `claude-opus-5` implementation review in session
`672ee956-7e9a-4041-9562-65cc95cfbb65` returned NO-GO with P0=0/P1=2.
It found that fatal heartbeat/configuration exits lost actionable diagnostics
and that a signal concurrent with a durable 403 could abort before
`permanentStop` was observed. The remediation preserves closed, reason-specific
operator messages and moves the terminal-halt check before the cooperative
yield. Executable tests cover both the 403-plus-SIGTERM intersection and the
diagnostic paths.

Two same-session exact-model deltas then returned PASS/GO with P0=0/P1=0.
The final delta used only `claude-opus-5`, had no permission denial and
returned P2=3. The Claude sandbox did not permit it to rerun Node; its static
review explicitly accepted the independently executed local gates reported
below. Its residual observations are nonblocking: direct executable
coverage of the generic lexical tie-break remains narrower than the proof by
closed ordering; a pre-effect stop is deliberately normalized to a retryable
closed cycle before clean shutdown; and the acceptance list above now names
the final hardening cases. The independent oracle also returned GO with
P0=0/P1=0 after 24/24 affected command/CLI tests.

The changed-file allowlist is intentionally limited to 12 paths:

- `runner/engine-serve-command.mjs`;
- `runner/engine-complete-http-effect.mjs`;
- the one-line terminal-yield ordering correction in
  `runner/engine-serve-cycle.mjs`;
- `runner/nexus-runner.mjs`;
- three new serve/effect test modules;
- the two inherited dark-gate test modules that must acknowledge the public
  boundary;
- the existing serve-cycle test module that proves terminal halt precedes
  cooperative yield;
- this release record; and
- the declared shared documentation hotspot, `docs/PROGRAM-PLAN.md`.

## Capability truth

This batch makes continuous heartbeat and recovery of previously durable
completion intents real. It does not create a local run. Governed claim,
encrypted prompt delivery, supervisor activation and Claude/Codex process
launch remain owned by B4.4a5.5. The overall execution capability remains
`roadmap` until the B4.5 product and evidence gate.

## Release gate

The exact final candidate passed:

- focused recovery/serve acceptance: 139/139;
- complete unit suite: 264/264;
- complete runner suite: 262/262;
- migration and preflight suite: 38/38;
- all seven API integration suites;
- production build and rendered-artifact smoke tests: 2/2;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities; and
- exact 12-path allowlist plus `git diff --check`.

## Rollback

Rollback removes the serve/effect modules and their tests and restores the
previous CLI dispatcher, the terminal-yield ordering and dark-gate assertions.
No schema, prompt, claim, provider configuration or new durable record
vocabulary was introduced. Already-settled completions remain valid. A
retained stale lock can be recovered by the existing next-owner protocol
before or after rollback once its recorded PID is no longer live.
