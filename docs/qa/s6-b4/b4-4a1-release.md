# S6.B4.4a1 release evidence

## Outcome

B4.4a1 adds the dark, forward-only storage boundary for local execution
receipts. An engine completion now has a database-enforced place for one
immutable, lease-pinned receipt and one encrypted, erasable stdout/stderr
excerpt payload. No route, runner daemon, Worker producer, UI action or
provider process writes the new storage in this batch.

Execution remains `roadmap`. The production build intentionally has no
`/api/runs/:runId/engine-complete` route, and the existing run-event and
Decision Ledger completion validators remain diagnostic-only. Direct storage
tests can prove the future transaction, while every current live completion
path still rolls back before an engine outcome can be presented as real.

## Architecture decision

Migration `0026_sticky_valkyrie.sql` is additive over 0025:

1. `run_engine_excerpts` stores one AES-256-GCM envelope per engine run.
2. `run_engine_receipts` stores one immutable terminal receipt per engine run
   and operation.
3. `runs_validate_before_update` is recreated from the 0025 validator with
   an exact engine-completion branch and a bidirectional diagnostic
   discriminator.
4. The existing `run_events_validate_before_insert` and
   `ledger_entries_validate_run_event` trigger SQL is byte-unchanged.

There is no foreign-key cycle. The future atomic write order is:

```text
runner operation -> encrypted excerpt -> immutable receipt -> run transition
```

The receipt is keyed by `run_id`, has a same-tenant unique operation id and a
composite foreign key to the operation tombstone. It also stores the exact
`excerpt_ref` and `excerpt_sha256`, with a same-tenant composite foreign key to
the encrypted payload. Its insert trigger requires the exact current active
lease, fence, assigned runner, selected engine, lease-pinned engine version,
unexpired lease, run deadline, operation timestamp and non-erased excerpt. A
pre-existing deadline operation blocks the receipt.

The receipt stores no provider text and no duplicate `summary`. The run
summary is derived as `completed` for `succeeded`, otherwise the closed
receipt reason. Status/reason/exit-code/cancel/timeout and per-stream
byte/hash/truncation facts mirror the frozen `EngineCompleteBody` consistency
matrix. A canceled receipt requires a persisted run cancellation request, but
that request does not overwrite a succeeded or failed adapter-observed
result. Every leased-to-completed transition increments the run version.

Runner `started_at` and `finished_at` remain digest-covered attestations with
only an internal ordering constraint. They are deliberately not compared to
the server clock. Deadline, lease, retention and reconciliation use only
`recorded_at`, preventing clock skew from turning a real result into a dark
one.

## Encrypted excerpt contract

One plaintext frame preserves stream separation without placing provider text
in metadata:

```text
u16be(stdout length) || stdout excerpt bytes || stderr excerpt bytes
```

The two excerpts total at most 1024 decoded bytes. The encrypted payload is
therefore 2–1026 bytes. Metadata retains only:

- opaque `exc_` reference;
- exact stdout/stderr excerpt byte counts;
- SHA-256 of the framed plaintext;
- cipher version/key id and lifecycle timestamps.

The AES-GCM AAD remains `runId|organizationId|payloadRef`. The distinct
`exc_` reference makes prompt/excerpt ciphertext substitution fail
authentication. Empty streams still have a two-byte authenticated frame.

Receipt provenance and digest facts are immutable and undeletable. Excerpt
key material permits exactly one live-to-erased transition after the same
inclusive 30-day terminal retention boundary as prompts. Reference, lengths,
digest, cipher version, creation time and erasure time survive crypto-shred.

## Key lifecycle and retention

The live-key coverage query now unions `run_prompts` and
`run_engine_excerpts`. Valid engine creation checks that the configured
keyring covers every live protected-payload key only after owner/admin and
assigned-runner validation, preserving the established 403/404/409 error
precedence. Removing a key while either protected payload kind references it
fails closed as `prompt_cipher_key_unavailable`.

Retention selects prompts and excerpts independently at `limit + 1`, so each
payload kind retains the exact 100 scheduled/local and 25 mutation bound.
The response aggregates changed/skipped/failure counts and reports
`truncated` when either kind has backlog. Health reports one payload-free
`promptRetention.overdue` bit if either kind exceeds the retention boundary
plus grace.

Retention imports no cipher or keyring and never selects encrypted bytes.
Missing, corrupt or retired keys cannot be misclassified as erasure.

## Storage and false-real adversarial evidence

The dedicated migration suite proves:

- all 27 migrations apply to an empty database;
- 0026 upgrades a populated 0025 database additively;
- event and ledger completion validators are byte-unchanged;
- engine `completed` without a receipt is rejected;
- success with the exact receipt can cross the run trigger only in direct
  storage tests;
- the still-diagnostic event validator rejects the corresponding engine
  completion event, preserving the false-real guard;
- wrong engine version, lease, fence, operation, deadline, outcome, exit
  code, excerpt reference/digest, empty-stream hash and truncation reject;
- a cancellation request remains auditable without overriding an observed
  success, while a canceled receipt still requires the request;
- receipts cannot update, replace or delete;
- excerpt ciphertext cannot be replaced or partially erased;
- erasure rejects one millisecond early and succeeds at the exact 30-day
  boundary;
- completed run status, summary and operation must match the receipt exactly;
- an engine completion without a run-version increment is rejected;
- the production build and runner source contain no engine-completion
  producer.

Domain tests additionally prove the 1024-byte frame boundary, malformed-frame
rejection, prompt/excerpt AAD substitution failure and equality between the
domain and SQL empty-stream SHA-256 constant.

## Automated evidence

The release candidate passed:

- 215 unit tests;
- 91 local-runner tests;
- 37 migration/storage/preflight tests, including real local Wrangler;
- all seven isolated live API integration suites;
- production build and two rendered/Worker artifact smoke tests;
- TypeScript, ESLint and Oxlint;
- Drizzle generation with no schema drift;
- production dependency audit with zero vulnerabilities at the configured
  high-severity gate;
- `git diff --check`.

The live runs suite also exposed an intentionally inconsistent chaos fixture:
100 queued poison candidates used a key id absent from the configured
keyring. The new guard correctly blocked the next creation. The fixture now
poisons only deadline-actor availability, its intended fault, while retaining
the configured encryption key.

The initial Opus storage review returned `PASS/GO`, P0=0/P1=2/P2=4. Fable
arbitrated the two P1 findings: runner timestamps are non-authoritative across
clock domains, while cancellation is a request fact rather than an outcome
override. The resulting hardening also added explicit excerpt reference and
digest commitment plus strict terminal version advancement. The final Opus
freeze gate returned `PASS/GO`, P0=0/P1=0. Its remaining non-blocking carry
forward is limited to a bounded retention-query index optimization and an
optional stricter standalone unframe contract; neither affects correctness,
privacy or the dark activation boundary. Atomic live writing remains an
explicit B4.4a2 gate.

## Rollback

Revert the code and route-read guard while leaving migration 0026 in place.
Prior binaries do not write either table, and the unchanged diagnostic
validators continue operating. Any dark rows remain immutable and become
usable after re-upgrade.

## Next batch

B4.4a2 may add the signed, canonical engine-completion route and repository
transaction. It must activate the event and ledger engine branches
atomically, compute both receipt and request hashes from exact wire bytes,
encrypt the excerpt before D1, preserve diagnostic goldens and still have no
runner caller until the outbox and supervisor batches are ready.
