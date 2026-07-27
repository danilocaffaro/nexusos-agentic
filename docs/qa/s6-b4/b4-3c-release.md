# S6.B4.3c release evidence

## Outcome

B4.3c is complete. NexusOS can now create one encrypted engine run through the
exact `POST /api/runs/engine` surface. The batch does not expose prompt reads,
lease claims or provider execution. Execution, Sandbox and Streaming remain
`roadmap`.

## Delivered behavior

- Pure identity validation, incremental body bounds and exact canonical parsing
  execute before storage access.
- The configured prompt keyring is resolved before D1. A local fallback exists
  only with `NEXUS_ALLOW_LOCAL_IDENTITY === "1"`; a malformed configured
  keyring never falls back.
- An active same-tenant human owner/admin may select only an active same-tenant
  assigned runner.
- AES-256-GCM encrypts the exact prompt with the frozen
  `runId|organizationId|promptRef` AAD and stores key, nonce, tag, ciphertext,
  digest and byte provenance without exposing them.
- One D1 batch atomically inserts the engine run, encrypted prompt,
  `run.created` event and Decision Ledger entry.
- Organization-ledger contention retries with stable run, prompt, event and
  ciphertext identities while rebasing only the predecessor and sequence.
- The exact 201 envelope contains run and event metadata only. `promptRef` and
  its digest grant no prompt-read authority.
- Diagnostic list, detail, cancel, claim, renew and completion paths cannot
  observe or mutate engine rows.
- `run.expired` is represented in the shared contract and diagnostic panel
  without activating deadline processing.
- The activation allowlist permits imports of the dark control foundations only
  from the engine-create route, D1 run repository and runner HTTP adapter.
  Engine claim and prompt-read routes remain absent.

## Review history

The first Opus 5 review returned `PASS/GO`, P0=0/P1=0/P2=3. Its three
non-blocking hardening observations were closed:

- the successful integration path now proves its randomized prompt sentinel is
  absent from captured server output;
- concurrent creations now prove complete four-row joins and consecutive,
  predecessor-linked Decision Ledger entries;
- the blueprint now freezes the exact metadata-only 201 response and states
  explicitly that reference and digest confer no authority.

The final delta review independently inspected the implementation and tests and
returned:

- verdict: `PASS`;
- release decision: `GO`;
- P0: 0;
- P1: 0;
- P2: 0.

It also confirmed that the dark-test evolution is an exact allowlist rather
than a weakened architectural gate.

## Automated evidence

The final candidate passed:

- TypeScript typecheck, ESLint and oxlint;
- 192/192 unit tests;
- 91/91 runner tests;
- 32/32 migration/preflight tests;
- governance/workspace, presence, realtime, artifacts, runner, invalid-keyring
  and runs API integration suites;
- zero-row failure behavior for a malformed configured keyring, with its secret
  sentinel absent from response and captured server output;
- concurrent engine creation with complete storage joins and continuous
  organization-scoped ledger hash chain;
- Drizzle generation with no schema drift;
- production build and rendered smoke;
- production dependency audit with zero vulnerabilities;
- `git diff --check`.

## Rollback

Remove the additive engine-create route and its wiring. Existing encrypted
engine rows remain valid and inert in the forward-compatible B4.3b schema and
become available again after re-upgrade. Diagnostic behavior is unaffected.

## Next batch

B4.3d activates only engine lease claim plus the minimum kind-aware shared
mutation changes. Admission must require the exact assigned runner and engine
from the latest fresh, ready, versioned engine inventory, pin that evidence in
the lease, respect the run deadline and return the frozen prompt-free
descriptor. No prompt-read or provider-execution surface is introduced.
