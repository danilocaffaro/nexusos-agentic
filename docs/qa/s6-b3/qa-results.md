# S6.B3 QA results

## B3.1 — Pipeline parity and frozen contract

> Status: PASS
> Date: 2026-07-26

Delivered:

- accepted architecture record and auditable Fable/Opus/Codex consensus;
- explicit ownership for all six non-blocking design P1 findings;
- GitHub CI runner-test parity;
- strict canonical capability-report v1 parser and checked-in fixture;
- stable declaration hash and exact 12-hour/24-hour freshness-edge oracle;
- frozen outbox-v1/v2 parser, derived paths and checked-in fixtures;
- rollback-safe sibling storage contract for future v2 entries;
- no report endpoint, persistence or capability claim activated.

Automated evidence:

- 111 unit tests passed;
- 11 reference-runner and outbox-contract tests passed;
- five migration suites passed from empty and historical schemas;
- governance, presence, realtime, artifacts, runners and runs API integrations
  passed;
- production build and rendered smoke passed;
- typecheck and lint passed;
- Drizzle generated no migration or schema drift;
- production dependency audit reported zero vulnerabilities;
- `git diff --check` passed.

The first Opus implementation review returned `BLOCK` with zero P0 and two
P1 findings. The corrected delta now rejects free-form version/path content,
uses the frozen validator in the live v1 reader and exercises checked-in v1
recovery plus real sibling-v2 preservation. Its related P2 findings are also
closed: canonical bounded freshness, domain-separated declaration hash,
composed report/outbox fixtures and a consistent 128 KiB entry envelope.

The Opus delta review confirmed both original P1 findings closed and found one
final local P1: the v2 envelope report id was not bound to the signed body id.
It explicitly authorized commit without another review after equality was
enforced, the normative fixture was corrected and focused tests passed. Those
conditions are satisfied: the parser now rejects identity drift even under a
recomputed checksum, the live reader rejects an altered v1 path, and it applies
the 128 KiB bound before reading. Empty declarations also fail structurally.

The focused post-fix gate passed 111 unit and 11 runner tests plus typecheck,
lint and diff check. The immediately preceding full post-review regression
passed every migration/integration, build, smoke, audit and drift gate. B3.1 is
therefore complete and B3.2 may begin.
