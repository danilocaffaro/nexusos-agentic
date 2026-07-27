# S6.B4.3b release evidence

## Outcome

B4.3b is complete. NexusOS now has forward-only, dark storage for encrypted
engine prompts, exact engine-inventory admission pins and effect-once deadline
expiry. No API route can yet create, claim, read or execute an engine run.
Execution, Sandbox and Streaming remain `roadmap`.

## Delivered storage

- Additive `engine_prompt` run kind, selected engine and immutable 20-minute
  deadline grammar while preserving every diagnostic branch.
- One encrypted `run_prompts` row per engine run with exact byte/digest
  provenance, opaque reference, AES-GCM shape checks, live-key lookup and
  one-way terminal crypto-shred after retention.
- Engine-inventory leases that require the latest fresh complete two-engine
  report, exact ready/available evidence and immutable engine, report,
  received-time and version pins.
- Exact `run.created`, `lease.claimed` and `run.expired` event grammars with
  actor, fence, metadata and effect-once validation.
- One immutable deadline operation per run and a matching immutable
  `run.expired` Decision Ledger proof.
- Exactly one mapped deadline-reconciler automation principal per
  organization, including forward provisioning, safe exact-shape adoption and
  collision/provisioning failure closure.
- Internal mapped principals excluded from presence, work assignment,
  conversation creation and member mutation. A database trigger provides a
  write-path backstop while ordinary automation and agent principals remain
  valid collaborators.
- Due-deadline, terminal-retention and live-key indexes for the later runtime
  batches.
- A dark-route gate proving that engine create, claim and prompt-read routes
  remain absent.

## Review history

The first Opus 5 review could not break the new run, prompt, lease, event,
operation or ledger invariants, but returned `FAIL/NO-GO`, P0=0/P1=1 because
the new system automation appeared in presence and remained eligible for work
assignment and collaboration membership.

After the exact mapped-principal filters were added, the delta review found one
remaining creation path in `requireConversationReferences`. That path was
closed at the repository layer and with a database trigger. Behavioral
coverage now proves the mapped principal is rejected while an ordinary
automation principal is accepted.

The final Opus review independently reran the focused, migration and unit
suites, scanned every other collaboration write path and returned:

- verdict: `PASS`;
- release decision: `GO`;
- P0: 0;
- P1: 0;
- P2: 3 non-blocking maintenance observations.

## Automated evidence

The final candidate passed:

- TypeScript typecheck, ESLint and oxlint;
- 192/192 unit tests;
- 8/8 dedicated engine-control storage tests;
- 32/32 migration/preflight tests, including real local Wrangler;
- governance/workspace and presence API integrations after the visibility
  hardening;
- all six API integration suites during the complete candidate review;
- Drizzle generation with no schema drift;
- production build and rendered smoke;
- production dependency audit with zero vulnerabilities;
- `git diff --check`.

## Rollback

The migration is forward-only and additive. A server rollback leaves the new
tables, columns, indexes, mappings and validators inert because no released
route can create an engine row. Prior diagnostic binaries continue to use the
explicit legacy branches unchanged. Reapplying the server code restores access
to the same encrypted storage grammar without destructive migration.

## Next batch

B4.3c activates only `POST /api/runs/engine`. It must resolve the keyring
before any D1 statement, validate an active same-tenant human owner/admin and
assigned runner, encrypt the exact prompt, atomically persist run, prompt,
event and ledger rows, and expose metadata only.
