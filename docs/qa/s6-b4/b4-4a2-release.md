# S6.B4.4a2 release evidence

## Outcome

B4.4a2 activates the server-side, signed engine-completion boundary without
activating a runner caller or a provider process. An assigned runner holding
the exact current engine lease can now submit one canonical terminal receipt
to:

```text
POST /api/runs/:runId/engine-complete
```

The route uses the frozen `nexus-runner-engine-complete-v1` signature domain,
the existing 4096-byte signed transport, server time, nonce replay and
semantic operation replay. Diagnostics retain their existing route, domain,
body and response bytes.

Execution remains `roadmap`: `runner/nexus-runner.mjs` has no
`engine-complete` caller, supervisor or provider-execution path in this
batch.

## Atomic completion

`completeEngineRun` validates, in order:

1. nonce and operation replay;
2. engine-run kind and tenant;
3. current active lease, runner and fence;
4. lease expiry and deadline reconciliation;
5. selected engine and lease-pinned engine version;
6. cancellation provenance;
7. availability of the protected-payload keyring.

Keyring resolution is lazy. A stored replay returns its exact 200 response
even if the keyring later becomes unavailable; only a new protected excerpt
requires encryption.

One D1 batch writes:

```text
operation -> encrypted excerpt -> immutable receipt -> completed run
          -> released lease -> release event -> completion event
          -> nonce -> runner liveness -> Decision Ledger
```

The run update is authoritative on current `status + lease + fence`, not on a
stale pre-read version. `runs_validate_before_update` enforces exactly
`OLD.version + 1` inside the same transaction, allowing a concurrent
cancellation request to remain an audit fact without overriding the
adapter-observed terminal result.

## Receipt and privacy commitments

The receipt digest commits to every stored, non-derived receipt fact,
including both independent race flags `cancelRequested` and `timedOut`,
stream byte counts, full-output digests, truncation flags, excerpt reference
and digest, engine/version, operation, lease/fence, runner timestamps and
authoritative server `recordedAt`.

Only the bounded stdout/stderr excerpt frame is encrypted. Full provider
output remains local. Operation replay bodies, nonces, events, ledger entries,
errors and logs contain no prompt or provider-output bytes.

The completion event has exactly eight content-free keys:

```text
engine, engineVersion, operationId, outcomeStatus, reason,
receiptSha256, stderrBytes, stdoutBytes
```

Migration `0027_s6b4_engine_completion_activation.sql` recreates only
`run_events_validate_before_insert` and
`ledger_entries_validate_run_event`. Every earlier diagnostic, claim,
deadline and fence branch is preserved. The new engine branches bind actor,
fence, timestamps and exact metadata to the immutable receipt and reject a
second engine-completion event.

## Adversarial evidence

The focused and live suites prove:

- exact Ed25519 domain/path/body binding and canonical JSON;
- nonce replay and semantic operation replay return stored bytes without
  reapplying effects;
- a changed body under the same operation id returns `operation_conflict`;
- engine mismatch, pinned-version mismatch and unrequested cancellation fail
  before any excerpt or receipt row exists;
- tampered receipt metadata, wrong ledger actor and duplicate completion event
  fail at the storage boundary;
- the excerpt SHA-256, receipt SHA-256 and ledger payload hash recompute from
  independent test code;
- ciphertext differs from the framed plaintext;
- one success produces exactly one excerpt, one receipt, four run events and
  two run-linked ledger entries;
- prompt and output sentinels are absent from operational response bodies and
  server logs;
- all 28 migrations apply to an empty database;
- the diagnostic completion flow remains green through migration 0027.

## Automated release gate

The final candidate passed:

- 216 unit tests;
- 91 local-runner tests;
- 38 migration/storage/preflight tests, including real local Wrangler;
- all seven isolated API integration suites;
- production build and two rendered/Worker smoke tests;
- TypeScript, ESLint and Oxlint;
- production dependency audit with zero vulnerabilities at the configured
  high-severity gate;
- Drizzle generation with no schema drift;
- `git diff --check`.

The initial Opus review returned `PASS/GO`, P0=0/P1=2. Fable confirmed both
fixes: include `timedOut` in the receipt commitment and remove the unsafe
pre-read version CAS. The focused final Opus review returned `PASS/GO`,
P0=0/P1=0. Its duplicate-event and three error-contract test-depth findings
were hardened before the full pipeline.

Non-blocking carry-forward: add an end-to-end decrypt assertion when an
authorized excerpt reader exists; consider narrower operator diagnostics for
protected-payload encryption failure without changing the frozen shared
keyring error contract; retain runner timestamps as commitment-covered,
non-authoritative attestations.

## Rollback

Application rollback removes the route and repository producer. Migration
0027 may remain in place: its engine branches are inert without a signed
producer, while every diagnostic branch is preserved. Re-upgrade resumes the
same receipt/event/ledger contract.

## Next batch

B4.4a3 may extend the existing outbox-v3 substrate with pending and
acknowledged engine-completion declarations. It must not yet spawn a vendor
CLI and must preserve exact replay bytes plus post-ack excerpt scrubbing.

