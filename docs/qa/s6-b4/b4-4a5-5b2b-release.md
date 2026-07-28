# S6.B4.4a5.5b2b release evidence

## Outcome

B4.4a5.5b2b closes the remaining dark runtime contracts required before
composition may activate provider execution:

- one absolute I/O deadline of at most 10 seconds for claim, prompt and renew;
- a fresh execution-readiness resolver that re-probes the configured binary,
  exact version, capabilities and authentication;
- an executable fingerprint carried through supervisor protocol v2 and
  checked again immediately before the adapter spawn;
- a durable `canceling` journal state for cancellation observed during renew;
- explicit recovery priority for that cancellation; and
- a physical rollback gate against the real B4.4a5.5b2a reader.

This batch does not compose claim, prompt, renew, lock ownership and spawn into
the public `serve` command. That activation belongs only to B4.4a5.5b2c.

## Absolute I/O deadline

Claim, prompt and renew use one shared monotonic deadline beginning immediately
before `signedRequest`. The same budget covers signing/transport, response
status and headers, every streamed body read, parsing, verification and prompt
buffer transfer. The upper bound is 10,000 ms and accepts only exact integer
configuration in `1..10000`.

The deadline owns an `AbortController`, passes its signal into the signed
transport and composes it with the runner's inherited 15-second fetch timeout.
Every timeout phase returns the closed result:

```json
{"code":"retryable","httpStatus":null,"kind":"response_error"}
```

Late transport results and body readers are consumed and canceled
best-effort. Prompt scratch and any copied prompt buffer are zeroed on every
timeout or failure path. A hostile synchronous getter cannot be preempted by
JavaScript; classification is therefore rechecked against the monotonic
deadline at every failure return. The regression matrix includes a status
getter that deliberately exhausts the budget before a headers getter throws.

## Fresh execution readiness

`resolveEngineExecutionReady` accepts only the parsed current configuration,
engine, expected version and explicit filesystem/process/identity/environment
ports. It never consumes an inventory snapshot. For every request it:

1. validates the configured binary and captures its realpath and fingerprint;
2. executes the exact version, help and optional feature probes;
3. requires the expected version to be supported and unchanged;
4. requires positive current authentication evidence; and
5. validates the binary again after all probes.

The output is either a deeply frozen `ready` value containing the exact binary
facts or a closed `not_ready` reason. Re-reading configuration immediately
before this resolver remains a B4.4a5.5b2c composition responsibility.

## Executable identity and supervisor v2

The fingerprint contains the six validated inode facts already used by engine
probing: device, inode, mode, modification time, size and owner. It is required
for execution adapters, forbidden for probe adapters and included in the
canonical `authorize_spawn` frame.

All supervisor bootstrap, control and event frames now require protocol
version 2. The child receives the fingerprint and the execution adapter
re-opens the exact realpath with `O_NOFOLLOW`, compares open-file metadata and
safe ownership/mode facts, and only then reaches the synchronous spawn site.
Any drift returns a closed `EIO` spawn failure without invoking the provider.

The durable supervisor and child identities now use the `sup2:` and `eng2:`
grammars, and the authenticated challenge uses its v2 domain. Active recovery
parses only v2 identities. A prior `sup1:` or `eng1:` journal therefore fails
ambiguous and never falls back to an older wire interpretation or authorizes a
second spawn. B4.4a5.5b2c closes this rollout requirement before real execution
is activated.

The fingerprint closes ordinary update, rename, inode and metadata drift under
the current trusted-same-UID host boundary. It is not a content digest and does
not claim protection from a hostile process running as the same user. Expanding
that threat model requires digesting from the opened descriptor and/or stronger
process isolation.

## Durable renewal cancellation

Renew success now returns the canonical wall-clock `observedAt` alongside the
validated renewal. If cancellation is true before spawning, the runtime can
append:

```text
claimed -> starting -> canceling -> result(cancel_requested)
```

`canceling.json` commits:

- attempt identity;
- `createdAt` and authoritative `observedAt`;
- source `renew`;
- cancellation=true;
- lease, fence, run and expiry; and
- the record checksum.

The reader independently enforces
`createdAt >= observedAt >= starting.createdAt`, exact lease/fence/run
correlation and `renewal.expiresAt <= starting.deadlineAt`.

`canceling` and `spawning` are mutually exclusive. If cancellation wins the
single-owner journal append, recovery returns `complete_prestart_cancel` and
spawn is structurally invalid. If `spawning` wins, the prestart cancellation
record is structurally invalid and B4.4a5.5b2c must use the supervised cancel
path. A result after `canceling` can only be `cancel_requested`; it then follows
the existing outbox and settlement path.

## Rollback proof

`npm run test:rollback:b2b` creates a detached worktree at the exact previous
reader commit `232b28edfbdc2564a6a77aede0d21e3484b149f2` and executes both real
stores:

| Scenario | Current reader | Previous reader |
| --- | --- | --- |
| `canceling.json` prefix | `complete_prestart_cancel` | quarantine attempt |
| existing starting-only prefix | `resume_prestart` | `resume_prestart` |

The prior reader treats the additive state as unknown and quarantines the
whole attempt. It cannot partially execute, complete or delete new state.
Existing journals remain readable in both directions.

## Adversarial acceptance

The matrices cover:

- signed transport hangs, late response cleanup and signal propagation;
- hostile and slow status/header/body/reader accessors;
- drip reads under one absolute deadline;
- prompt scratch zeroing and canary absence;
- exact versions, capability tokens and positive authentication;
- every fingerprint-field drift before spawn;
- protocol v1/v2 confusion and canonical frame bounds;
- duplicate authorize controls and terminal reconnect replay;
- parent death after spawn without a second provider launch;
- cancellation crash recovery and forged renewal evidence;
- cancel-vs-spawn mutual exclusion; and
- physical previous-reader rollback.

The independent oracle found one P1 during review: a synchronous response
getter could cross the deadline and a subsequent throwing getter was still
classified as protocol/200. Failure classification was made
deadline-authoritative across all response paths, explicit claim/prompt/renew
regressions were added, and the same oracle re-audited the corrected result.

## External architecture and implementation review

The frozen Fable architecture session is
`13c0c45a-70a0-4538-b2e1-e4d77965dc5d`; the implementation-review session is
`21281221-4c1b-4d32-83b4-a2cec9d3ab1c`.

A fresh Claude Code CLI Fable review was attempted against this exact diff.
The CLI reached the authenticated service but returned HTTP 429 with zero
tokens because the account remains at its monthly spend limit. This is
recorded as unavailable external review, never as a PASS. The existing frozen
Fable decisions, executable gates and independent oracle remain the release
authorities.

## Release gate

The final candidate passed:

- focused HTTP/deadline matrix: 98/98;
- complete runner suite: 434/434;
- complete unit suite: 298/298;
- TypeScript;
- ESLint and Oxlint;
- `git diff --check`;
- production dependency audit: zero vulnerabilities; and
- physical B2b rollback: GO for both directions.

## Explicit handoff

B4.4a5.5b2c may now compose the dark contracts under the existing single-owner
serve lock. It must re-read engine configuration, resolve fresh readiness,
claim, persist `starting`, renew and fetch the prompt under the same fenced
identity, resolve cancel-vs-spawn by the journal append order, persist
`spawning` before supervisor launch and pass the exact readiness fingerprint
into protocol v2.

Renew-cancel and spawn must re-read and append under the same short lock
capability; separate files alone do not serialize two producers. B4.4a5.5b2c
must also close the supervisor cross-version rollout choice before activation.

No engine may be launched from inventory evidence alone, no cancellation may
exist only in memory, and no public activation may bypass the durable journal.
