# NexusOS Architecture Blueprint

## System context

```text
Browser
  |
  v
NexusOS control plane
  |-- identity and organization
  |-- work and collaboration
  |-- governance and ledger
  |-- artifacts and releases
  |-- workflows and operations
  |
  +--> effect gateway --> GitHub / provider APIs / remote MCP
  |
  +<-- outbound secure channel -- Nexus Runner
                                 |-- CLI sessions
                                 |-- sandboxes
                                 |-- local MCP
                                 +-- local credentials
```

## Bounded contexts

| Context | Owns |
| --- | --- |
| Identity | principals, organizations, memberships, sessions |
| Work | projects, objectives, work items |
| Collaboration | conversations, messages, presence, media-session metadata |
| Agents | agent definitions, teams, connection assignments |
| Governance | ActionIntents, policies, approvals, ledger events |
| Execution | runs, runner enrollment, leases, run events |
| Artifacts | artifacts, versions, lineage, releases |
| Automation | workflows, triggers, schedules, loop budgets |
| Capabilities | skills, MCP connectors, memory policies |
| Integrations | GitHub and optional anti-corruption adapters |

Governance has no dependency on collaboration. A message may reference an
intent, but it can never mutate one.

The workspace core keeps four concerns separate:

- `principals` establish identity for humans, agents and system actors;
- `agent_definitions` hold role, model, memory scope and autonomy;
- `team_members` assign a principal to a project-scoped team;
- `model_connections` hold provider/method/status and allowlisted non-secret
  metadata only. OAuth and CLI secrets stay outside D1.

All workspace records carry organization scope. Mutable aggregate roots use an
integer version and compare-and-swap updates. Archives are soft and dependency
aware so audit history and foreign-key lineage remain intact.

## ActionIntent contract

Minimum fields:

- `id`, `organizationId`, `projectId`
- `proposerId`, `actionType`, `targetRef`
- canonical `parameters` and `parametersHash`
- `preconditions` with observed target versions
- `riskTier`, `policyDecision`
- `requiredApprovals`, `approvals`
- `expiresAt`, `idempotencyKey`
- `status`, `supersedesIntentId`
- `createdAt`, `updatedAt`

Lifecycle:

```text
DRAFT -> PROPOSED -> APPROVED -> EXECUTING -> SUCCEEDED
                   \-> REJECTED             \-> FAILED
                   \-> EXPIRED              \-> INTERRUPTED
                   \-> CANCELLED
```

After `PROPOSED`, payload mutation creates a new intent. Execution verifies
expiry, current preconditions, parameter hash and a fencing token.

Multi-step effects are sagas. Every step has its own precondition, receipt and
ledger event. Compensation is explicit; an incomplete saga is never reported
as successful.

## Effect gateway

Only the effect gateway receives connector credentials. Connector methods
accept an `ExecutableIntent`, not arbitrary text. That value can only be minted
after policy and approval validation.

The local runner is a separate trust zone. Its first production version must
choose and state one of two models:

1. Enforced sandbox: network/filesystem/credential brokers verify signed
   intents before releasing capabilities.
2. Operator trust: governance claims cover only Nexus-mediated effects and the
   UI clearly states that out-of-band runner actions are outside the ledger.

NexusOS must never imply stronger enforcement than the selected model provides.

## Ledger and privacy

Ledger hash:

```text
sha256(canonicalJson({
  ...eventEnvelope,
  sequence,
  previousHash
}))
```

The envelope contains identifiers, event kind, actor, timestamp and hashes of
evidence. Personal text, prompts, transcripts and erasable payloads are stored
as encrypted blobs behind content-addressed references. Deleting an allowed
payload preserves chain integrity while making the content unavailable.

The chain is anchored periodically to a Git commit or another independently
controlled location. Verification reports broken links, missing payloads and
unanchored ranges separately.

## Runner protocol v1

```text
enroll -> register capabilities -> heartbeat
       -> receive lease offer -> claim with fencing token
       -> emit ordered run events
       -> request ActionIntent when needed
       -> wait for approval
       -> execute or stop
       -> upload receipts/artifacts
       -> complete
```

The runner connects outbound and maintains a durable local outbox. Events use
`(runId, sequence)` deduplication. A stale fencing token cannot complete a run.
Long polling is the fallback when WebSocket/SSE is unavailable.

## Persistence

- D1/SQLite via Drizzle for relational control-plane state.
- R2 or filesystem adapter for logs and blobs.
- Repository interfaces isolate domain services from runtime drivers.
- Migrations are forward-only and committed.
- Ledger serialization may use a per-organization coordinator after concurrency
  tests prove it necessary.

## Realtime

Phase 1 uses HTTP commands and sequence-aware SSE/polling. Clients reconnect
with `afterSequence` and receive backfill from durable storage. Presence is
ephemeral and expires by TTL. Presence history and time-online analytics are not
collected.

## Motor and reuse strategy

NexusOS owns orchestration, authority, evidence and user experience. It does not
fork every agent tool into its core.

- **Connect:** prefer stable CLI/API/protocol integration for Claude Code,
  Codex CLI, Goose, OpenCode, OpenHands and similar engines.
- **Encapsulate:** run engines behind the runner and `ExecutionEngine` contract.
- **Reuse:** borrow proven sandbox, patch, terminal and tool-loop techniques
  only through compatible open-source libraries.
- **Distill:** implement only the small primitives that are strategic Nexus
  invariants, especially ActionIntent, policy, ledger, leases and provenance.

An engine adapter implements `start`, `resume`, `cancel`, `streamEvents`,
`requestIntent` and `collectArtifacts`. No engine becomes a database or source
of organizational truth.

## Dependency policy

Required and free/open:

- NexusOS control plane and runner code
- SQLite-compatible persistence
- Git repository for source and optional ledger anchor
- one supported model access path chosen by the user

Optional:

- GitHub hosted features beyond Free
- Jira, Slack, Teams, Notion and other SaaS
- managed Cloudflare deployment
- external transparency or media providers
