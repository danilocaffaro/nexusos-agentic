# NexusOS QA Strategy

## Evidence layers

1. Unit: pure domain behavior and negative transitions.
2. Contract: API, runner and connector payload compatibility.
3. Integration: route, repository and migration behavior with a real local DB.
4. End-to-end: complete user journeys through the browser.
5. Visual: desktop and mobile behavior, dialogs and error states.
6. Security: authority, tenant isolation, secrets and malicious payloads.
7. Resilience: retries, network interruption, stale leases and partial effects.
8. Product: acceptance metric and capability-honesty review.

## Mandatory critical scenarios

- Agent or message payload attempting to approve an intent is rejected.
- Expired approval cannot execute.
- Changed target precondition blocks execution.
- Duplicate delivery does not duplicate an effect.
- Runner with stale fencing token cannot complete.
- Cross-organization identifiers do not leak data.
- Ledger modification is detected.
- Erasable evidence deletion keeps the chain valid and reports content missing.
- Provider fallback is reported and budgeted.
- Workflow stops at maximum steps and maximum spend.
- Presence expires and exposes no private prompt content.
- Last deployed version matches external deployment evidence.

The current collaboration gate additionally proves:

- duplicate direct conversations are rejected;
- cross-project and cross-tenant references fail closed;
- non-members receive not-found behavior and cannot enumerate a conversation;
- observers and members of archived conversations cannot write;
- forged system-message kinds are rejected;
- concurrent sends receive unique monotonic sequences without loss;
- chat text that resembles an approval does not change an `ActionIntent`;
- message envelopes reject update and delete at the database boundary;
- an integrity hash is keyed and cannot be recomputed from plain message text.
- an empty conversation mode never selects a conversation from another mode;
- drafts remain isolated by conversation and survive view navigation;
- a delayed initial snapshot cannot erase an optimistically displayed message;
- a POST response cannot advance the polling cursor past unseen messages;
- list, polling and action failures retain independent user feedback.
- membership history and pin history cannot be deleted at the database layer;
- the final active conversation owner cannot leave, be removed or be demoted;
- a pin cannot cross tenant or conversation boundaries and never copies an
  erasable payload.

## QA-full cycle

For each release candidate:

1. Generate `qa-discovery.md` from rules, routes, schema and UI flows.
2. Generate numbered scenarios in `qa-test-plan.md`.
3. Execute without fixing during the evidence collection pass.
4. Record proof and defects in `qa-results.md`.
5. Fix defects in separate batches.
6. Run an independent verification through Claude Code.
7. Record convergence or dissent in `qa-consensus.md`.

The release threshold is at least 98% overall and 100% of critical scenarios.
Tests that only exercise fixture data do not count toward release acceptance.

## CI tiers

Pull request:

- format/typecheck/lint
- unit and contract tests
- migration-from-empty test
- build and server-render smoke
- critical browser smoke

Integration runs use a newly created temporary D1 persistence directory and
remove that directory after the server stops. Tests never weaken append-only
production triggers merely to clean fixtures.

Main:

- all pull-request checks
- integration suite
- preview deployment and smoke
- artifact and migration provenance

Nightly:

- complete browser suite
- visual regression
- dependency and secret scanning
- ledger verification
- chaos subset

Release candidate:

- full QA cycle
- accessibility audit
- load and soak tests
- backup/restore rehearsal
- runner disconnect/replay test
- security review and threat-model closure
