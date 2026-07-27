# S6.B4.4a4.3 release evidence

## Outcome

B4.4a4.3 adds the dark, crash-safe local execution supervisor that can retain
one bounded provider-CLI attempt across a controller crash. It connects no
public runner command, claim loop, prompt fetch, completion producer or serve
loop. Execution therefore remains `roadmap`.

The slice consists of a mutually authenticated loopback protocol, a detached
supervisor process, the controller used to start or resume it and the existing
bounded Claude Code/Codex adapter seam. The parent process is the only writer
of the durable attempt journal. The supervisor retains the exact child
identity and terminal result until explicit authenticated acknowledgement.

## Safety and recovery contract

- The first hello contains only attempt identity, kind, nonce and protocol
  version. The supervisor proves knowledge of the token with HMAC before the
  parent sends the token-bearing attach frame.
- Spawn authorization is effect-once and bound to the exact canonical request
  fingerprint. An identical replay does not spawn twice; a divergent replay
  fails closed.
- `started.json` is durable before the supervisor can release prompt bytes to
  child stdin.
- The controller owns a synchronous copy of caller prompt bytes before its
  first await, verifies its digest and zeroes owned prompt buffers
  best-effort after authorization.
- The provider process receives no prompt through argv, environment or a
  durable prompt file. Scratch is a deterministic private directory associated
  with the attempt.
- A reconnect replays the same child identity and terminal result. It cannot
  authorize a second spawn.
- Result acknowledgement and abandon are distinct authenticated controls.
  Result retention is bounded by the attempt deadline/grace and never by a
  five-second controller window.
- Inspection is non-destructive and cannot evict an active controller.
- Ambiguous supervisor identity, refused transport or PID reuse never causes
  a journal PID to be signaled, a prompt to be replayed or scratch to be
  removed automatically.
- Control frames, frame queues, active sockets, handshakes and captured output
  are all bounded. The first stdout byte beyond 262144 is classified exactly
  as `output_limit_reached`.

## Automated evidence

The real-executable suite proves:

- successful execution with exact stdin/output hashes and durable ordering;
- caller-buffer mutation cannot change the committed prompt;
- missing executables fail before child start without a fictitious started
  record;
- controller `SIGKILL` resumes the same child without a second launch;
- duplicate spawn authorization and terminal replay remain effect-once;
- unauthenticated and forged handshakes disclose no token and cannot pin an
  attempt;
- inspection leaves the controller and provider execution intact;
- a PID-reuse decoy is never signaled;
- bounded control-frame flooding launches no child;
- authenticated abandon reaps a gated child and exact scratch;
- stdout overflow records the exact capped byte count and digest; and
- importing or directly invoking the supervisor entrypoint is inert unless its
  private bootstrap contract is present.

The complete post-fix pipeline passed:

- typecheck;
- 218/218 unit tests;
- 169/169 runner tests;
- 38/38 migration and preflight tests;
- all seven API integration suites;
- production build and 2/2 rendered-artifact smoke tests;
- ESLint and Oxlint; and
- production dependency audit with zero vulnerabilities.

After S7.B1 was integrated, the combined branch repeated the complete pipeline
successfully, including 228/228 unit tests, the same 169 runner tests, all
integrations, build, smoke, lint and the zero-vulnerability production audit.

## Review, remaining boundary and rollback

The first Claude Opus 5 review found that the draft disclosed the attachment
token in its initial hello and identified missing boundedness and cleanup
gates. Mutual authentication, setup-failure cleanup, terminal retention,
socket/handshake bounds, deterministic scratch cleanup and the adversarial
test matrix closed those blockers. The final exact-model delta returned
`PASS/GO`, P0=0/P1=0.

The supervisor still has no production caller. The next reversible slice is a
dark single-writer coordinator that reconciles the attempt journal with the
durable engine-completion outbox. Public `nexus-runner serve`, claim/prompt
network activity and capability promotion remain outside this release.

Rollback removes the supervised controller/child modules and their focused
tests. The prior journal, completion sender and adapter formats remain intact;
no server schema, route or public CLI surface changes in this slice.
