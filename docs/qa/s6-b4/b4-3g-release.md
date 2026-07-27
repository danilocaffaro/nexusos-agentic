# S6.B4.3g release evidence

## Outcome

B4.3g activates automatic one-way prompt retention. Ciphertext for terminal
engine prompts is crypto-shredded at the exact inclusive 30-day boundary while
opaque integrity and provenance facts remain immutable. Provider execution,
engine completion, receipt storage and direct or early prompt erasure remain
inactive.

## Architecture decision

No schema migration, proprietary service, provider credential or keyring
lookup is added. Migration 0025 already supplies:

- the live-versus-erased `run_prompts` state check;
- an update trigger that permits exactly one complete crypto-shred no earlier
  than 30 days after terminal `runs.recorded_at`;
- delete and repeat-update denial;
- the terminal-run and live-key indexes.

The prompt row and its guarded one-way update are the effect-once identity.
There is no erasure operation table, event or ledger kind. `erased_at` is the
immutable audit fact, while the existing run events and ledger history remain
unchanged.

Fable reviewed this boundary and returned `GO`, P0=0/P1=0. Earlier governed
erasure is deliberately not approximated: the storage trigger forbids it and a
future implementation requires an explicit migration plus high-risk
`ActionIntent`.

## Exact retention contract

Eligible runs are `engine_prompt` rows in `completed`, `canceled` or `expired`
state with non-null terminal `recorded_at`. Eligibility is inclusive:

```text
observedAt - recordedAt >= 2,592,000,000 ms
```

For expired runs, `recorded_at` is the successful reconciliation time, not the
original deadline. A delayed scheduler therefore retains ciphertext longer,
which is the safe direction.

Each candidate executes one guarded statement that sets `key_id`, `iv`,
`ciphertext` and `tag` to null and sets canonical `erased_at`. It preserves:

- `run_id` and `organization_id`;
- opaque `prompt_ref`;
- `cipher_version`;
- `prompt_sha256` and exact `prompt_bytes`;
- `created_at`;
- all run events and Decision Ledger entries.

One changed row is `erased`; zero is a benign concurrent/replay skip. A trigger
abort becomes a closed per-row failure and does not stop later candidates.
Retention never imports or resolves the prompt cipher, so missing or retired
keys cannot block the operation.

## Scheduling, bounds and operations

- The existing production Worker cron runs deadline reconciliation followed by
  prompt retention every minute.
- Successful engine create, claim, renew and prompt-read requests schedule one
  combined maintenance promise.
- Each Worker isolate allows one mutation pass in flight and applies a
  30-second cooldown.
- Scheduled and local retention passes select at most 100 rows.
- Mutation-time retention selects at most 25 rows.
- Retention rows use the terminal-time/run-id index order; storage checks make
  every live prompt row structurally coherent.
- The local command accepts only literal HTTP loopback addresses
  `127.0.0.1` and `[::1]`, refuses credentials, source-asserts redirect
  refusal, and reaches a local-mode-only exact-body endpoint.

The deadline and retention loops isolate their own failures. Neither can
change the response of the authoritative mutation that scheduled maintenance.

## Health and privacy

`/api/system/health` reports only:

```json
{
  "promptRetention": {
    "overdue": false
  }
}
```

The signal becomes overdue after the 30-day boundary plus a ten-minute
operational grace. It exposes no organization, run, prompt reference, key id
or timestamp and does not turn an otherwise reachable database into HTTP 503.

Maintenance selection projects only opaque row identity, terminal status/time
and prompt reference. Logs contain counts, truncation and closed error classes
only. They never select or log plaintext, prompt digests, ciphertext, keys,
IVs or authentication tags.

## Automated evidence

The release candidate covers:

- 30 days minus 1 ms, the exact inclusive boundary and 1 ms after it;
- bounded 25/100 selection and coherence-first ordering;
- two concurrent live D1 sweeps with one total effect per prompt;
- replay with zero new effects;
- key id, IV, ciphertext and tag removal with reference/hash/bytes retained;
- health overdue before and healthy after retention;
- real literal-loopback retention CLI plus source-asserted redirect refusal;
- a forced trigger abort returning one opaque failure and HTTP 503, followed
  by successful recovery;
- 100 poisoned deadline candidates ahead of one healthy run: the healthy run
  expires, 99 failures remain isolated and `truncated=true`;
- absence of a direct erasure route, provider execution and engine completion;
- production Worker artifact containing the scheduled maintenance trigger;
- 211 unit tests, 32 migration/storage tests, live runs integration, build,
  smoke, TypeScript, ESLint, Oxlint, schema no-drift and diff hygiene.

The full commit gate passed:

- 211 unit tests;
- 91 local-runner tests;
- 32 migration and storage tests;
- all seven isolated live API integration suites;
- production build and two rendered/Worker artifact smoke tests;
- TypeScript, ESLint and Oxlint;
- schema generation with no drift;
- production dependency audit with zero vulnerabilities at the configured
  high-severity gate;
- `git diff --check`.

The independent Claude Opus 5 review returned `PASS`, release `GO`, P0=0 and
P1=0. Four non-blocking findings were closed before the final gate: encrypted
blobs were removed from selection, maintenance health probes were isolated,
retention ordering became index-aligned and truncation became an exact
`limit + 1` probe. A focused post-hardening review again returned `PASS/GO`,
P0=0/P1=0. The remaining performance observation is that SQLite may use a
temporary merge for the three terminal-status index branches; correctness and
write bounds are unaffected.

## Rollback

Remove the retention repository/domain modules, local endpoint and CLI, health
field, Worker invocation and combined mutation hook. No migration is rolled
back. Already-erased rows remain valid immutable historical facts; re-upgrade
resumes from remaining live terminal prompts.

## Next batch

B4.4 may activate provider execution and encrypted engine receipts only after
freezing the runner process boundary, completion protocol, cancellation
precedence, receipt retention and sandbox truth. Prompt retention remains
independent of provider availability.
