# S6.B4.3e release evidence

## Outcome

B4.3e is complete. NexusOS can now return an encrypted engine run prompt to
the exact assigned runner through the signed
`POST /api/runs/:runId/prompt` surface. The only successful payload is the
original UTF-8 byte sequence under `application/octet-stream`; provider/CLI
execution, completion, deadline reconciliation and retention remain inactive.

## Delivered behavior

- The additive binary wrapper uses the distinct
  `nexus-runner-engine-prompt-read-v1` signature domain and accepts only the
  canonical `fence`, `leaseId` and `promptRef` body.
- Query strings, absent/false/oversized content length, noncanonical bodies,
  malformed runner headers, stale signatures and signatures from another
  domain fail closed before the repository handler.
- A pure evaluator freezes the denial order for runner activity, tenant,
  engine-run state, cancellation, exact assignment, lease/fence ownership,
  expiry, opaque reference and erasure.
- On a fresh read, one D1 batch inserts the prompt-free sentinel, updates
  runner liveness only when that exact sentinel exists, and selects ciphertext
  under the same authorization facts. Decryption occurs only after the batch
  commits.
- A guard miss writes no nonce and does not advance runner liveness. A
  read-only evaluation after the miss classifies the closed error.
- The nonce row stores only canonical `{"promptRef":"prm_..."}` with the
  signed request hash. It never stores response bytes, ciphertext, key
  material or prompt text.
- Same nonce and exact signed request rechecks the current runner, run,
  assignment, lease, fence, expiry, reference and payload state, then reads
  and decrypts again with zero writes. A different signed request under the
  nonce returns `nonce_reused`.
- AES-256-GCM decryption reconstructs D1 BLOB values through strict byte
  validation, binds the frozen `runId|organizationId|promptRef` AAD and
  revalidates exact byte count plus SHA-256 after decrypt.
- Unknown keys, malformed envelopes, bad tags/AAD and digest/count mismatch
  collapse to `prompt_cipher_key_unavailable` (503). They are never
  reclassified as erasure and return no prompt metadata headers.
- Success returns only `no-store`, `nosniff`, prompt reference, SHA-256, byte
  count and optional replay headers. Error bodies remain canonical JSON.
- No event, semantic operation, ledger entry, run mutation, schema migration,
  UI path, process spawn, provider access or credential access is included.

## Security decisions

Read idempotency intentionally permits an exact captured signed request to
re-read the prompt only while the signature timestamp remains inside the
60-second past-skew window and all current authorization facts still hold.
The 15-minute nonce retention period does not extend signature validity.
Revocation, cancellation, supersession and expiry therefore override the
earlier successful registration.

Cancellation returns the same `run_unavailable` envelope as other unavailable
run states. This is an intentional fail-closed information boundary; it does
not expose whether a cross-tenant or otherwise unavailable run exists.

The corrupt-payload integration case removes the immutable prompt-update
trigger only inside a disposable Wrangler database, injects a digest mismatch,
asserts the closed 503 response and immediately recreates and verifies the
trigger before subsequent tests.

## Review history

Fable inspected the merged cipher, storage, nonce, signed transport and engine
claim foundations before implementation. It returned architecture `GO` with
four mandatory conditions: additive binary transport, guard and ciphertext
read in one batch before decrypt, write-free fully reauthorizing replay, and
plaintext egress only through the octet-stream response.

The first Opus 5 implementation review returned implementation `PASS` but
release `NO-GO`. P0 was zero. Its two P1 findings required a live HTTP denial
matrix and evidence for the guard-miss branch.

The candidate was hardened by making the guarded D1 batch the first run-state
authority, guarding liveness on the exact inserted sentinel, and adding live
coverage for:

- wrong tenant, same-tenant wrong runner, wrong lease, fence and reference;
- revoked runner, cancellation, expiry and diagnostic cross-kind probes;
- corrupt digest with exact 503 response, no prompt headers and no plaintext;
- concurrent duplicate nonce, exact replay and nonce conflict;
- wrong signature domain, query string, noncanonical body and missing length;
- zero nonce and unchanged liveness for denied runners.

The final Opus delta review independently reran typecheck, lint, 204 unit
tests, 32 migration tests and the full runs integration. It returned:

- verdict: `PASS`;
- release decision: `GO`;
- P0: 0;
- P1: 0.

Its only P2 concerned restoration of the trigger used by the test-only
corruption setup. The trigger is now recreated and verified immediately after
that assertion.

## Automated evidence

The release candidate passed:

- TypeScript typecheck, ESLint and oxlint;
- 204/204 unit tests, including the pure denial matrix and binary-wrapper
  source pinning;
- 91/91 runner tests;
- 32/32 migration/preflight tests;
- live create, inventory, claim, binary read, replay, concurrency and closed
  denial cases against an isolated Wrangler/D1 database;
- governance/workspace, presence, realtime, artifacts, runner and invalid
  keyring integration suites;
- production build and rendered smoke;
- Drizzle generation with no schema drift;
- production dependency audit with zero vulnerabilities;
- `git diff --check`.

## Rollback

Remove the additive prompt-read route, binary wrapper, pure evaluator and
repository read function. No migration is rolled back. Existing nonce rows
contain only opaque sentinels, expire through the existing cleanup and cannot
reconstruct plaintext; encrypted prompt rows remain readable after re-upgrade.

## Next batch

B4.3f activates realizable deadline expiry through the existing mapped system
actor and immutable deadline-operation storage. It must converge queued and
leased engine runs exactly once across scheduled, local and mutation-time
entry points. Provider execution remains inactive.
