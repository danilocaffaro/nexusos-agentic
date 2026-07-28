# S6.B4.4a5.5b2a release evidence

## Outcome

B4.4a5.5b2a closes the additive journal and local prestart contracts needed
before the engine-attempt runtime may perform claim, prompt or supervisor
effects:

- one durable `spawning` write-ahead boundary before supervisor launch;
- local descriptor rejection evidence that is independently re-verifiable;
- durable prestart cancellation provenance copied from the claimed descriptor;
- durable prompt and claim denial settlements;
- a total coordinator decision for every new recovery state;
- shared claim, runtime and journal lease limits; and
- a physical bidirectional rollback gate against the real B4.4a5.5b1 reader.

The public runner and serve entry points do not activate claim acquisition,
prompt retrieval, renewal, supervisor launch or provider execution in this
batch. B4.4a5.5b2b and B4.4a5.5b2c still own those effects and their explicit
operator-controlled activation.

## Monotonic attempt grammar

The additive prestart paths are:

```text
claimed -> settled(rejection)
claimed -> settled(server denial)
claimed -> starting -> result(prestart failure or descriptor cancellation)
claimed -> starting -> spawning -> result(prestart failure)
claimed -> starting -> spawning -> started -> ...
```

`spawning` is mandatory before the supervisor side effect. A recovered
`starting` prefix returns `resume_prestart`; the coordinator assigns it an
explicit priority and defers the actual effect to the next runtime slice.
Once an operation is outboxed, neither a local rejection nor an earlier
denial may be appended.

`starting.createdAt` must be strictly earlier than `expiresAt`. It commits the
exact descriptor engine, version, fence, lease, run, deadline, timeout, prompt
metadata, output bounds and `cancelRequested` value. A prestart canceled
receipt is valid only when that durable value is `true`; a caller cannot
manufacture cancellation after the fact.

## Local rejection evidence

Only two local descriptor rejection reasons exist:

1. `lease_expired`;
2. `engine_deadline_insufficient`.

Expiry has priority when both are true at the same observation. The durable
record contains the complete normalized descriptor, `observedAt` and the
reason. The journal reader re-derives the reason at that exact observation
and correlates descriptor run and engine identity with `claimed`.

`observedAt` is the single authoritative proof instant. `createdAt` records
when the append completed and proves only `observedAt <= createdAt`. This
avoids a two-clock race where a deadline-insufficient descriptor is observed
before lease expiry but persisted after it. The regression matrix also proves
that a descriptor accepted at observation cannot be relabeled as rejected
merely because persistence crosses expiry.

The real claim HTTP effect returns the same complete descriptor and canonical
observation time with `descriptor_rejected`. A composition test feeds that
result directly to the durable producer without reconstruction.

## Shared limits

`runner/engine-lease-limits.mjs` is dependency-free and freezes the numeric
limits used by claim, runtime and journal validation:

| Limit | Value |
| --- | ---: |
| Descriptor bytes | 4,096 |
| Prompt bytes | 8,192 |
| Deadline reserve | 30,000 ms |
| Effective-timeout minimum | 270,000 ms |
| Descriptor timeout range | 270,000-600,000 ms |
| Maximum fence | 2,147,483,647 |

This removes numeric drift between producers and the independent journal
reader.

## Rollback proof

`npm run test:rollback:b2a` creates a real detached worktree at base commit
`e419c30`, imports the previous parser/store and compares them with the current
parser/store. It exercises five checked-in scenarios:

| Scenario | Current reader | B4.4a5.5b1 reader |
| --- | --- | --- |
| Prestart rejection | recover | quarantine |
| Prestart canceled result | recover | quarantine |
| Prompt denial | recover | quarantine |
| Starting with cancel flag | recover | quarantine |
| Legacy supervisor without spawning | quarantine | recover |

The manifest key set must exactly equal the scenarios physically exercised.
The prior result is obtained by executing the real previous code; the
in-tree test does not compute an expected prior answer from its own manifest.

Rollback is safe because unknown additive records are quarantined rather than
partially interpreted. Rolling back cannot execute, deliver or delete an
attempt it does not understand.

## Adversarial acceptance

The focused matrices cover:

- exact record key sets, checksums and cross-record identity;
- strict lease chronology and timeout bounds;
- rejection precedence and two-clock persistence crossings;
- forged reason, descriptor, run and engine evidence;
- descriptor-derived cancel provenance and false-cancel rejection;
- prompt denial source/status pairs;
- impossible rejection or denial after outbox;
- mandatory `spawning` before every supervisor effect;
- `resume_prestart` recovery and total coordinator priority;
- hostile records, accessors and malformed inputs;
- current-to-previous and previous-to-current rollback behavior; and
- absence of public runner/serve activation.

The independent local oracle initially blocked the batch on four rounds of
real contract defects, including discarded rejection evidence, absent cancel
provenance, equality at lease expiry and the two-clock rejection race. The
final read-only re-audit returned `GO`, P0=0, P1=0 and P2=0.

## Architecture and review evidence

The exact architecture session is
`13c0c45a-70a0-4538-b2e1-e4d77965dc5d`, run with
`claude-fable-5` and read-only tools. Fable froze:

- rejection as local evidence rather than an outboxed operation;
- precedence `lease_expired > engine_deadline_insufficient > cancel
  convergence > accepted`;
- the complete descriptor plus observation proof;
- durable descriptor cancellation provenance;
- mandatory `spawning` before the supervisor effect;
- explicit `resume_prestart`; and
- separate observation and persistence timestamps, with the reason derived at
  observation.

The implementation-review session is
`21281221-4c1b-4d32-83b4-a2cec9d3ab1c`, using exact
`claude-opus-5`. Its earlier review found the impossible rejection/outbox
combination, unverifiable evidence, cancellation ambiguity, missing
write-ahead enforcement, incomplete recovery handling and a tautological
rollback test. Those findings were corrected. The requested final same-session
read-only pass inspected the candidate but the CLI withheld its response with
HTTP 429 because the account reached its monthly spend limit. This is recorded
as an unavailable external review, not as a false PASS. The independent local
oracle and executable gates are the final authorities for this small batch.

## Release gate

The final candidate passed:

- claim-effect and lease-runtime focused tests: 81/81;
- complete unit suite: 298/298;
- complete runner suite, isolated: 416/416;
- physical rollback gate: GO in all five scenarios;
- TypeScript;
- affected-file ESLint and Oxlint;
- `git diff --check`; and
- independent read-only oracle: GO, P0=0/P1=0/P2=0.

One runner execution launched concurrently with the unit and typecheck suites
reported one transient failure under host contention. The unchanged candidate
was rerun in isolation immediately and passed 416/416. The isolated result is
the release authority; the full combined pipeline will run again after Team B
integration.

## Frozen activation boundary

The inherited public entry modules remain byte-identical:

| Path | SHA-256 |
| --- | --- |
| `runner/nexus-runner.mjs` | `bb90298f172107a0b5b4d48d9fd0da6999e2945b204aed98ec894b88431acede` |
| `runner/engine-serve-cycle.mjs` | `b44b6a0c3fd495402b843eb4efaf4bf58fbeddf1e6199e367561b5e4eb094822` |
| `runner/engine-supervisor-child.mjs` | `0ef19780d293f93910b875d5204bf17fcfbd94d0e4a1e20445500233d85fd3e6` |
| `runner/engine-adapters.mjs` | `ce6693e54337aa4cd2c317ccf8187531f8edebc2d375713cfd0b4b0cd32409ec` |

`engine-supervised-run`, the attempt coordinator and the claim effect are
hardened internal seams, but no public entry imports the dark orchestration
path introduced for the remaining slices.

## Explicit handoff

B4.4a5.5b2b must give claim and prompt reads absolute 10-second deadlines,
resolve and revalidate the exact provider executable/version/auth state, and
make renewal-observed cancellation durable before spawning. It must not launch
a supervisor merely to make that cancellation representable.

B4.4a5.5b2c may then connect the dark runtime to the existing single-owner
serve loop under an explicit run ID and engine, with no ambient polling.
