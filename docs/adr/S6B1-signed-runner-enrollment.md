# S6.B1 — Signed runner enrollment and truthful liveness

## Status

Accepted on 2026-07-26 after Fable/Opus adversarial review.

## Context

Sprint 6 introduces the execution plane without silently weakening the
governance spine. Before a runner can lease or execute work, NexusOS needs a
cryptographic machine identity, a revocation path and an honest liveness
projection. This batch must not imply that the runner is sandboxed, that its
host is attested or that any out-of-band action is covered by the Nexus ledger.

The control plane runs on Cloudflare Workers and D1. D1 batches are atomic but
do not provide an interactive transaction that can branch on the result of an
earlier statement. Enrollment is also a public route: it cannot depend on the
local/test human identity headers used by authenticated UI routes.

## Decision

`S6.B1` is identity and connectivity only. An active human owner/admin issues a
single-use enrollment token with a 15-minute lifetime. A runner generates an
Ed25519 keypair locally, proves possession of its private key when enrolling,
and then uses detached signatures for heartbeat requests. The private key,
model credentials and CLI sessions never enter the control plane.

The selected trust model is `operator_trust`. NexusOS verifies identity,
authorization to enroll, revocation and liveness. It does not yet verify the
runner host, sandbox, filesystem, network or local process behavior. The runner
cannot lease or execute work in this batch.

The trust disclosure is not a tooltip:

> This runner executes on infrastructure you control. NexusOS verifies its
> cryptographic identity and liveness only; it does not yet sandbox, inspect or
> supervise local execution. Anyone holding the private key can act as this
> runner. Revoke it immediately if the host is compromised.

## Storage

`runner_enrollment_tokens` stores:

- opaque id and organization;
- SHA-256 of the decoded 32-byte token, never its plaintext;
- issuing human, intended display name, issue and expiry times;
- optional revocation time/actor;
- optional consumption time and consuming runner id.

`runners` stores:

- runner id, organization and a dedicated `kind=runner` principal;
- the one enrollment-token id;
- canonical unpadded base64url encoding of the raw 32-byte Ed25519 public key;
- `active|revoked`, enrollment/revocation metadata and `last_seen_at`;
- `operator_trust` as the closed trust profile.

`runner_heartbeat_nonces` stores a 15-minute replay window per runner:
`(runner_id, nonce)` primary key, request hash, exact response status/body and
observation time. Expired rows are operational replay state and may be deleted;
they are not audit history.

Uniqueness covers token hash globally, runner principal, enrollment token and
`(organization, public_key)`. Triggers reject tenant-mismatched principals,
non-runner principals, invalid status transitions, mutable identity/key/token
links and inconsistent revocation fields.

The ledger adds four typed metadata-only events:

- `runner_token.issued`, actor = human issuer;
- `runner_token.revoked`, actor = human revoker;
- `runner.enrolled`, actor = newly created runner principal;
- `runner.revoked`, actor = human revoker.

The current SQLite schema does not encode the Drizzle string enum as a database
`CHECK`, so adding kinds does not rebuild, rehash or resequence existing ledger
rows. Heartbeats never enter the ledger.

## Tokens and deterministic identity

Tokens are 32 cryptographically random bytes encoded as 43 unpadded base64url
characters. The plaintext is returned once and is never accepted through a URL,
process argument or environment variable.

Lost enrollment responses must be recoverable without storing the token
plaintext. Runner and principal ids are deterministic over the token hash and
public key with distinct domains:

```text
PID = "prn_" + sha256(
  "nexus.principal.id.v1\n" + tokenHashHex + "\n" + publicKeyBase64url
)[0:32]

RID = "rnr_" + sha256(
  "nexus.runner.id.v1\n" + tokenHashHex + "\n" + publicKeyBase64url
)[0:32]
```

The 128-bit truncated digest is an identifier, not an authentication secret.
The ≥256-bit token entropy makes exposing RID/PID safe against preimage search.

## Detached request signatures

The enrollment token is sent only as `Authorization: Bearer <token>`.
Enrollment body bytes are read once, limited to 4 KiB and parsed from that same
buffer. The body is `{ "displayName": "..." }`; the public key and signature are
detached headers:

- `X-Nexus-Runner-Key`: 43-character raw public key, base64url unpadded;
- `X-Nexus-Signature`: 86-character raw signature, base64url unpadded;
- `X-Nexus-Timestamp`: exact UTC RFC3339 with millisecond precision;
- `X-Nexus-Nonce`: 16 random bytes, base64url unpadded.

Canonical decoding re-encodes and byte-compares every base64url value. Padding,
the standard base64 alphabet, non-canonical trailing bits, wrong lengths,
low-order public keys and WebCrypto import failures are rejected.
Timestamp grammar is exactly `YYYY-MM-DDTHH:mm:ss.sssZ`: uppercase trailing
`Z` and three fractional digits are required; offsets and leap-second syntax
are rejected.

Enrollment signs the following UTF-8 bytes, joined by LF with no trailing LF:

```text
nexus-runner-enroll-v1
POST
<request URL pathname exactly as observed>
<configured NEXUS_RUNNER_AUDIENCE>
<timestamp header>
<nonce header>
sha256:<lowercase hex of exact request body bytes>
```

Heartbeat uses the same shape with domain
`nexus-runner-heartbeat-v1`. Queries are rejected. Audience is a server
configuration constant and is never derived from `Host`,
`X-Forwarded-Host` or `X-Forwarded-Proto`. The pathname is taken from
`new URL(request.url).pathname`; router normalization or percent-decoding is
not substituted into the signed bytes.

Timestamps older than 60 seconds or more than 30 seconds in the future fail.
The server clock, never the signed timestamp, determines stored liveness.

## D1 enrollment algorithm

The server validates bounded input, token encoding, detached signature, public
key and timestamp before a write. Missing or malformed tokens still take the
same validation path using fixed dummy material where necessary.

For each of at most five attempts:

1. Read the token by hash and the current organization ledger head.
2. Derive PID/RID and a deterministic response from stored enrollment time.
3. Build the next canonical `runner.enrolled` entry.
4. Execute one D1 batch in this exact foreign-key-safe order:
   1. conditionally insert the runner principal when the token is either
      unconsumed/live or already consumed by this RID;
   2. conditionally insert the runner with the same token guard and a matching
      expected principal;
   3. conditionally set token consumption only after the runner exists with
      the expected public key;
   4. conditionally append `runner.enrolled` only when the token's consuming
      runner id equals this RID and no event already exists for this RID.
5. Read token/runner state once and classify the committed outcome.

Every insert uses SQL guards, not a JavaScript decision inside the batch.
Replays skip already existing deterministic rows. A uniqueness failure on the
ledger sequence, token, public key or identity aborts the entire batch. Ledger
contention re-reads the head, recomputes the entry hash and retries the whole
batch with bounded jitter. Exhaustion returns `409 conflict_retry`; it never
retries only the ledger statement.

Classification is:

- token consumed by RID and stored key matches: byte-stable `200`, including
  a lost-response retry after token expiry;
- token consumed by another RID, revoked, expired or invalid: uniform
  enrollment rejection;
- token still live and unconsumed after a contention no-op: retry.

Thus one token creates at most one runner, a same-token/same-key retry converges
on that runner, and a different key never does. Principal, runner, consumption
and enrollment event either all commit or all roll back.

Token issuance, token revocation and runner revocation use the same
read-head/build-entry/atomic-batch/retry discipline. Revoking a runner changes
both runner and principal status in the same batch as `runner.revoked`.
Already-revoked resources are idempotent and never append duplicate events.

## Heartbeat and replay

The signed runner id is bound by the route pathname. Authentication loads
runner and principal together and requires both to be active. Revocation is
therefore effective on the next request with no cached grace period. Stored
nonce-response replay is evaluated only after that active-state check, so a
revoked runner never receives a cached success.

The heartbeat body is exactly the two UTF-8 bytes `{}`. Any other body fails
schema validation even when it has a valid signature.

For a first `(runner, nonce)`, one D1 batch:

1. inserts nonce, hash of the complete string-to-sign and exact serialized
   response;
2. advances `last_seen_at` using server time only when it moves forward.

A nonce uniqueness failure rolls the whole batch back. The stored row is then
read:

- same request hash: replay the stored status/body byte-for-byte, add
  `X-Nexus-Replay: 1`, do not advance liveness;
- different request hash: `409 nonce_reused`, no write.

Nonce expiry is at least ten times the total accepted clock-skew window and the
expiry index supports bounded cleanup.

Liveness is a read-time projection:

- `revoked` if the runner is revoked;
- `pending` if no heartbeat has succeeded;
- `online` when age is less than 90 seconds;
- `stale` from 90 seconds through less than 10 minutes;
- `offline` at 10 minutes or later.

No cron writes a stored liveness label.

## API

- `POST /api/runners/enrollment-tokens` — active human owner/admin; returns
  `{ tokenId, token, expiresAt }`, plaintext once.
- `POST /api/runners/enrollment-tokens/:tokenId/revoke` — owner/admin;
  idempotent resource revocation.
- `POST /api/runners/enroll` — public bearer-token plus detached runner
  signature; never resolves a human request identity.
- `POST /api/runners/:runnerId/heartbeat` — signed runner request.
- `GET /api/runners` — active workspace member; returns public identity,
  derived liveness and trust disclosure, never token/key-secret metadata.
- `POST /api/runners/:runnerId/revoke` — active human owner/admin.

Unknown, expired, revoked, malformed, wrong-key, bad-signature and skewed
enrollment attempts return the same `403` status, headers and canonical body:
`{"error":"enrollment_rejected"}`. Cross-tenant authenticated resources retain
the existing not-found behavior. The route is bounded before crypto and has a
deployment-rate-limit hook; the open-source baseline can enforce the same
policy without a paid identity or issue tracker.

## Runner CLI

`nexus-runner enroll` generates the Ed25519 keypair locally. The token is read
from a hidden TTY prompt or `--token-stdin`; a token argument and token
environment variable do not exist. The PKCS8 private key is written with
exclusive creation and mode `0600` inside a `0700` directory. It is never
logged. On a definitive enrollment rejection, the newly staged key is removed;
an ambiguous network result retains it so the same key can recover the
committed enrollment.

The runner opens outbound HTTPS only. It starts no inbound listener in this
batch. Provider engines remain optional adapters behind the future
`ExecutionEngine` contract.

## Rejected alternatives

- Reusing a human session for the runner: conflates operator and machine
  authority and cannot be safely revoked.
- Token-only heartbeat: a copied bootstrap secret becomes a permanent
  credential.
- Signature embedded in the signed JSON: creates a circular body hash.
- Token-derived runner id without the public key: a different key could collide
  with the retry identity.
- Host-derived audience: trusts attacker-controlled proxy headers.
- Stored `online|offline`: becomes false as soon as a scheduler misses.
- Heartbeat ledger events: create high-volume chain contention without
  governance value.
- Jira, GitHub Issues or a provider CLI as the runner registry: makes an
  optional adapter the authority root.

## Deferred

Key rotation, capability registration, attested/enforced sandboxes, run leases,
fencing, outbox replay, `ExecutionEngine`, engine credentials, run streaming,
cancellation, outcome evidence and chaos/disconnect recovery are later Sprint
6 batches. The UI labels every one of those capabilities `roadmap`.
