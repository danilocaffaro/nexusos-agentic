# S6.B2 — Versioned diagnostic leases and durable runner outbox

## Status

Accepted and implemented on 2026-07-26 after two Fable architecture passes,
two Opus implementation reviews and a final `PASS` with zero P0/P1.

## Context

S6.B1 established a revocable Ed25519 machine identity and signed heartbeat,
but a live runner still cannot coordinate ownership of work. S6.B2 must prove
that exactly one current runner can own a diagnostic run, a stale runner cannot
write an outcome, and a completed outcome survives a runner crash or a lost
HTTP response.

The batch is deliberately narrower than execution. It does not run a shell,
provider CLI, tool or user payload. It also does not introduce the run-event
streaming channel reserved for S6.B5.

Cloudflare D1 batches execute statements sequentially and atomically, but do
not allow application code to branch inside a transaction. Every transition
therefore uses read-head, guarded batch and read-classify. SQL triggers defend
the storage invariants independently of the repository.

## Decision

S6.B2 adds a fixed `diagnostic` run. A human owner/admin requests it and runs a
copyable local command for one enrolled runner. The runner:

1. persists a stable claim intent;
2. signs and claims a versioned lease;
3. holds it for 45 seconds and renews every 20 seconds;
4. persists the exact completion request before network I/O;
5. delivers or replays that request until NexusOS records one outcome.

The capability surface may label leases and durable replay `real`, scoped to
this closed diagnostic. Execution, sandbox and streaming remain `roadmap`.

## State model

A run is `queued | leased | completed | canceled`. It stores:

- organization, requesting human, `kind=diagnostic` and creation/deadline;
- optimistic `version`, monotonic `lease_generation`, current lease id and
  claim count;
- optional cancellation request;
- optional terminal outcome, summary, operation id and recording time.

A lease is `active | superseded | released | revoked`. It stores its run,
runner, integer fence, issue/expiry/renewal timestamps and terminal metadata.
There is at most one active lease row per run. A new claim increments the
run's `lease_generation`; renew never increments it.

Wall-clock expiry makes a lease eligible for reassignment. It does not by
itself invalidate a completion. A completion is authoritative when its lease
id and fence still equal the run's current lease and generation in the same
atomic batch. Reassignment changes both, so an old holder receives
`409 lease_superseded` and can never overwrite the newer owner. This keeps the
fence, rather than two competing clock and token rules, as the single authority
against zombie completion.

Cancellation of a queued run closes it immediately. Cancellation of a leased
run records `cancel_requested`; renew exposes that bit and the runner completes
with the `canceled` outcome. If the holder disappears, a subsequent cancel
after lease expiry or deadline atomically releases the lease, transitions
`leased -> queued -> canceled`, and records both events. A claim is also
allowed while `cancel_requested` is set and returns that bit immediately, so a
replacement runner converges by completing with a `canceled` outcome. These
paths intentionally permit either terminal `canceled` or
`completed`/`outcome=canceled`, depending on which valid convergence path wins.
Runner revocation atomically revokes its active leases and leaves their
non-terminal runs eligible for a new fenced claim.

## Operational event stream and ledger

`run_events` is append-only and ordered by `(run_id, sequence)`. S6.B2 emits:

- `run.created`;
- `lease.claimed`;
- `lease.renewed`;
- `lease.superseded`;
- `lease.released`;
- `lease.revoked`;
- `run.cancel_requested`;
- `run.completed`;
- `run.canceled`.

It is an operational timeline, not a runner-provided stream. The server writes
all rows. Metadata is canonical, bounded JSON and never contains prompts,
credentials or arbitrary output.

The organization Decision Ledger receives only low-volume, metadata-only
`run.requested` and `run.completed` events. Claims and renewals do not contend
on the global ledger.

## Detached signatures

Lease-plane requests reuse the S6.B1 Ed25519 key, audience, canonical encodings,
skew window and nonce rules. The authentication envelope adds:

- `X-Nexus-Runner-Id`: canonical `rnr_` id used to load the verification key.

For S6.B2 only, the runner id is added as a line after the signature domain:

```text
<domain>
<runner id>
POST
<request URL pathname exactly as observed>
<configured NEXUS_RUNNER_AUDIENCE>
<timestamp header>
<nonce header>
sha256:<lowercase hex of exact request body bytes>
```

The runner id is not duplicated in the JSON body. Including the envelope key id
in signed bytes prevents verification-key substitution. S6.B1 enrollment and
heartbeat strings remain unchanged.

Domains are:

- `nexus-runner-lease-claim-v1`;
- `nexus-runner-lease-renew-v1`;
- `nexus-runner-run-complete-v1`.

Every request body is at most 4 KiB, is read once, and must equal the canonical
JSON serialization of the parsed contract. Queries are rejected.

## Nonce replay versus semantic idempotency

`runner_lease_nonces` is a 15-minute cryptographic anti-replay window. It keys
`(runner_id, nonce)` and stores the full string-to-sign hash plus exact response
bytes. Identical reuse returns those bytes with `X-Nexus-Replay: 1`; changed
reuse returns `409 nonce_reused`.

This is not a durable outbox. A retry after restart has a fresh timestamp,
nonce and signature.

`operationId` is the semantic idempotency key: `op_` followed by 32 lowercase
hex characters. Claim and completion bodies carry a stable operation id.
`runner_operations` keys `(run_id, operation_id)` and stores the request hash,
fence, exact response status/body and application time. It commits in the same
D1 batch as the lease or outcome effect.

Classification after signature and active-runner validation is:

- same operation and request hash, body retained: return the exact stored
  status/body without another effect and mark `X-Nexus-Replay: 1`;
- same operation with a different hash or authenticating runner:
  `409 operation_conflict`;
- same operation compacted to a tombstone:
  `410 operation_horizon_exceeded`;
- no operation: evaluate and apply the guarded state transition.

After 30 days, cleanup sets response bytes to `NULL` and records
`compacted_at`; it never deletes the row while the immutable run exists.
Operation rows leave storage only if a future governed retention policy purges
the run itself. Exact response replay is guaranteed for 30 days and
non-reapplication for the life of the run.

Each fresh delivery signs the exact body bytes stored in the local outbox using
a new current timestamp and random nonce. Thus nonce anti-replay and semantic
idempotency remain independent.

## API

Human session routes:

- `POST /api/runs/diagnostic`, exact body `{}` — owner/admin creates one run;
- `GET /api/runs` — member lists bounded recent diagnostic runs;
- `GET /api/runs/:runId` — member reads state and ordered events;
- `POST /api/runs/:runId/cancel`, exact body `{}` — owner/admin requests or
  completes cancellation.

Signed runner routes:

- `POST /api/runs/:runId/lease/claim`,
  `{"operationId":"op_<32hex>"}`;
- `POST /api/runs/:runId/lease/renew`,
  `{"fence":N,"leaseId":"lse_<32hex>"}`;
- `POST /api/runs/:runId/complete`,
  `{"fence":N,"leaseId":"lse_<32hex>","operationId":"op_<32hex>","outcome":{"status":"succeeded|failed|canceled","summary":"..."}}`.

Success bodies expose run id, lease id, fence, expiry/cancellation or terminal
recording metadata. Errors are canonical and bounded. Runner authentication
failures uniformly return `403 runner_rejected`; stale ownership returns
`409 lease_superseded`; an expired diagnostic deadline returns
`409 run_unavailable`.

## Local durable outbox

The dependency-free Node 22 runner uses one file per operation:

```text
<state-dir>/
  runner.json
  identity.pk8
  outbox.lock
  outbox/
    op_<32hex>.json
    op_<32hex>.json.tmp-<pid>-<random>
    corrupt/
```

An entry contains version, operation id, kind, creation time, run/path,
base64url exact body bytes, body SHA-256, local state, optional exact response
and a checksum over the canonical envelope without the checksum field. It
contains no enrollment token, private key or model credential.

Every creation and state change:

1. opens a same-directory temporary file exclusively with mode `0600`;
2. writes the complete checksummed envelope and `fsync`s the file;
3. closes and atomically renames it over the final entry;
4. `fsync`s the outbox directory where the platform permits.

No first send occurs before the pending entry crosses that boundary. At
startup, temporary files are removed and corrupt/schema-invalid/checksum-invalid
entries are moved to `outbox/corrupt`; healthy pending entries continue in
creation order.

`outbox.lock` uses exclusive creation. A live recorded pid causes exit code 3
before network I/O. A dead pid is removed and acquisition is retried once.
This is intentionally an operator-trust lock, not a distributed lock.

Acknowledged/rejected/superseded entries remain seven days for inspection and
may then be pruned. `abandoned` entries require explicit pruning.

Linux gets file and directory fsync. On macOS Node fsync protects process
crashes but cannot request `F_FULLFSYNC`, leaving a small hard-power-loss
window. Windows skips unsupported directory fsync; rename/ACL behavior is
documented rather than represented as POSIX durability.

## Constants

- lease TTL: 60 seconds;
- renewal interval: 20 seconds;
- diagnostic hold: 45 seconds;
- default run deadline: 15 minutes, allowed range 1–60 minutes;
- maximum claims: 5;
- nonce replay: 15 minutes;
- exact operation-response retention: 30 days;
- local acknowledged-entry retention: 7 days;
- retry backoff: full jitter from 1 second to a 60-second cap;
- claim race retries: 3; ledger retries: 5.

## Rejected alternatives

- Treating nonce replay as the outbox: it cannot recognize a freshly signed
  retry after the nonce window.
- Replaying renew after restart: it extends work the runner was not servicing.
- A separate diagnostic event endpoint: overlaps S6.B5 streaming.
- An append log: requires torn-tail recovery and compaction without a S6.B2
  throughput benefit.
- Deleting operation rows after 30 days: makes an old retry indistinguishable
  from a new operation and can duplicate effects.
- Rejecting every post-expiry completion: discards real work even when no newer
  fence exists.
- Keeping response bytes forever: unbounded storage without improving the
  persistent tombstone guarantee.

## Deferred

Arbitrary execution, sandbox enforcement, capability attestation, provider CLI
adapters, event streaming, output receipts, automatic work polling and
multi-run concurrency remain S6.B3–S6.B6.
