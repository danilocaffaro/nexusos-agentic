# S6.B4.4a4.1 release evidence

## Outcome

B4.4a4.1 adds the dark, append-only local attempt journal that later
supervisor and delivery batches must consume. It adds no CLI command, network
caller, prompt file, process supervisor or engine spawn. Production behavior
and capability labels do not change; execution remains `roadmap`.

The journal lives in:

```text
<stateDir>/attempts-v1/
  corrupt/
  att_<32hex>/
    claimed.json
    starting.json
    supervisor.json
    started.json
    result.json
    outboxed.json
```

`supervisor.json` is the durable identity record inside the logical
`starting` phase. The five logical attempt states remain `claimed`,
`starting`, `started`, `result` and `outboxed`.

## Durable contract

Directories are real, same-owner and mode `0700`; records are real same-owner
files with mode `0600`. Every record is exact canonical JSON with one trailing
newline, an opaque attempt id, canonical timestamp, schema version, explicit
state and SHA-256 over its checksum-free canonical preimage.

Records are created through a synced temporary file and an exclusive atomic
hard-link. A state file is never rewritten. Ordinary records are bounded to
4096 bytes; the result record is bounded to 8192 bytes so it can hold the full
already-bounded execution receipt plus journal commitments. Before an
`outboxed` head is accepted, its exact completion body must also fit the shared
4096-byte server limit.

The claim record commits to the exact canonical semantic-replay request:

```json
{"engine":"claude_code_cli","operationId":"op_..."}
```

Its digest is recomputed from `engine` and `claimOperationId`, so those facts
cannot drift independently. The existing live Runs integration already
proves that resending this same engine-claim operation returns the exact
stored response with `x-nexus-replay: 1`, while a changed engine under the
same operation id returns `operation_conflict`.

The starting record pins the server lease, fence, engine/version, deadline,
timeout, fixed output bounds and opaque prompt facts, but no prompt bytes.
Supervisor and child records contain only pid plus bounded process-start
token. The result embeds one receipt that crosses the same strict parser used
by the completion outbox. The outboxed record retains only operation and body
digests. Its body digest is recomputed from the exact canonical
`{fence, leaseId, operationId, receipt}` completion body, binding the journal
to the future outbox bytes. The completion operation id must differ from the
claim operation id, preventing an accidental replay of the claim response.

## Structural transitions and recovery

Validation requires one attempt id, non-regressing record times, matching
run/engine/version facts and this dependency graph:

```text
claimed -> starting -> supervisor -> started -> result -> outboxed
                              \------> result
```

The second result path is permitted only for a closed, zero-output pre-child
failure such as `spawn_failed`, with both timeout and cancellation facts false;
it never invents a child identity.

The pure recovery decision is:

| Durable head | Decision |
| --- | --- |
| `claimed` | replay exact claim |
| `starting` without supervisor identity | block for operator attention |
| `supervisor` | inspect supervisor identity |
| `started` | inspect supervisor/child identity |
| `result` | persist exact completion outbox |
| `outboxed` | deliver exact completion outbox |

The deliberately blocked `starting` window prevents a timeout-based second
spawn. Recovery of that ambiguity remains an a5 chaos/readiness concern.

Unknown state files, directory/record identity mismatch, broken dependency
prefixes, schema/checksum drift, unsafe state-record permissions and symlinked
records quarantine the whole attempt by atomic rename. Unsafe cleanup-only
temporary files emit a warning without discarding an otherwise deliverable
attempt. Transient filesystem errors surface without quarantining a healthy
attempt. An unsafe journal-root symlink fails before its target is chmodded or
populated. Recovery removes only exact stale temporary crash remnants after a
five-minute grace; current or recently modified temps are left untouched.
Unsafe temps do not stop other stale remnants from being cleaned and synced.
The public serve batch must still hold the state-directory single-writer lock
before producing or recovering attempts. Validated records and their nested
receipts are returned as deep-frozen copies.

## Automated evidence

The focused journal suite proves:

- every checked-in record fixture is canonical, checksummed and bounded;
- every valid head maps to exactly one recovery action;
- identity, time, engine/version and dependency drift fail closed;
- the completion body digest is recomputed from lease, fence, operation and
  receipt facts;
- the exact completion body cannot exceed the shared server limit;
- claim and completion operations cannot reuse the same id;
- a pre-child failure reaches result without a fictitious `started` record;
- post-child `protocol_invalid` cannot use the pre-child path;
- pre-child receipts cannot claim timeout or cancellation;
- claim body facts and digest cannot diverge;
- each state append is immutable, `0600` and byte-identical to its fixture;
- exact stale temporary crash remnants are removed after a grace while recent
  temps survive;
- an unsafe temp warns without suppressing a valid delivery decision;
- invalid transitions create no state file;
- checksum corruption, unsafe permissions, symlinks and unknown contents
  quarantine the whole attempt;
- directory identity drift quarantines instead of duplicating an attempt;
- root symlinks cannot redirect permission or directory mutations;
- journal modules import no fetch or process-spawn surface.

The final release pipeline passed:

- 218 unit tests;
- 117 runner tests, including 110 top-level runner cases;
- 38 migration, storage and lease-preflight tests;
- all seven local API integrations;
- production build and two rendered smoke tests;
- full ESLint and Oxlint;
- production audit with zero vulnerabilities;
- Drizzle generation with no schema drift;
- clean diff checks.

The first adversarial Opus review found six P1 gaps, all corrected before
release. Two full re-gates then returned `PASS/GO` with P0=0/P1=0, and the
final focused delta review also returned `PASS/GO`, P0=0/P1=0.

## Rollback and next batch

Rollback removes the two dark journal modules and fixtures. There is no
producer in this batch, so a rollback cannot strand an attempt.

B4.4a4.2 may add the dedicated signed completion-delivery function and recovery
drain that consume an already-outboxed attempt. It must keep generic v3
delivery disabled, preserve exact outbox bytes and add no claim, prompt read,
supervisor or engine spawn.
