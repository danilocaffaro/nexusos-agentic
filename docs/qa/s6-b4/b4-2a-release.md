# S6.B4.2a release evidence

## Outcome

B4.2a is complete. NexusOS now has the dark, schema-free foundation for
privacy-safe Claude Code and Codex CLI inventory without executing a provider
turn or exposing a new API or UI capability.

Delivered:

- canonical local `engines.json` v1 configuration for zero to two optional
  engines, with closed keys and canonical absolute paths;
- a pure injected-port probe core that validates executable identity,
  ownership, permissions, path components and bounded metadata/auth outcomes;
- exact, canonical engine report and acknowledgement mirrors in TypeScript and
  runner JavaScript, fixed to a complete two-engine snapshot and one golden
  declaration hash;
- privacy-safe readiness classification that retains no raw provider output,
  path, account, credential or OAuth state;
- a self-contained runner constants mirror with CI parity against the
  control-plane contract;
- complete sibling outbox-v3 pending and scrubbed terminal contracts,
  cross-version duplicate detection, quarantine, recovery and seven-day
  pruning;
- an explicit dark delivery refusal and CLI-level proof that recovered v3 work
  remains inert while diagnostic and capability-report flows continue.

Execution, Sandbox and Streaming remain `roadmap`. B4.2a introduces no route,
migration, production filesystem/process adapter or UI truth promotion.

## Automated gates

Reproduced locally on 2026-07-27:

- typecheck: pass;
- unit: 174/174;
- runner: 43/43;
- migrations/preflight: 22/22;
- governance, presence, realtime, artifacts, runners and runs integrations:
  pass;
- production build and rendered smoke: pass;
- ESLint and oxlint: pass;
- production dependency audit: zero vulnerabilities;
- Drizzle generation: no schema changes;
- diff hygiene and static no-process/no-route/no-schema checks: pass.

## Independent implementation review

Opus 5 reviewed the complete uncommitted candidate after two hardening deltas.
The final result was:

- verdict: PASS;
- P0: 0;
- P1: 0;
- P2: 2 non-blocking observations;
- release pipeline: GO.

Both P2 observations were resolved before release. The device/inode
Number/BigInt negative matrix now covers both identity fields, and the
numbered QA traceability list is contiguous.

The final review independently confirmed canonical BOM rejection, string-only
versions, complete fixed engine ordering, privacy-safe auth handling, exact
binary identity validation, frozen v1/v2 behavior, prototype-safe declaration
dispatch, runner self-containment and dark v3 network inaccessibility.

## Rollback

The batch is dark and schema-free. Reverting its ordered implementation commits
removes the report/probe and outbox-v3 foundation without changing any existing
server route, database schema, UI claim or v1/v2 delivery behavior.

Older runner releases ignore and preserve the sibling `outbox-v3` directory.
No v3 writer is reachable from the production CLI until B4.2c.

## Next batch

B4.2b adds the signed server inventory, append-only engine report/evidence
history, generalized declaration nonce service and governed engine freshness.
It must preserve every B3 capability-report byte, response, error and side
effect. Engine execution remains prohibited.
