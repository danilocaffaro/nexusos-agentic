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
| Attention | personal actionable projections over governed records |
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

The work graph is provider-independent:

- `objectives` are project-scoped outcomes with a closed lifecycle;
- `work_items` carry a Nexus reference, state, priority and optional objective
  or assignee;
- `external_ref` is reserved for a reconciled adapter mapping and never
  replaces the Nexus id;
- local transitions are validated by pure domain code, compare-and-swap
  persistence and same-tenant database triggers;
- GitHub Issues, Jira and other trackers are anti-corruption adapters whose
  writes must pass through the effect gateway.

The collaboration model is also provider-independent:

- `conversations` unifies direct messages, team rooms and context-bearing
  handoffs;
- `conversation_members` is the authorization boundary for reading and
  writing a conversation; removal is a versioned status change and database
  triggers prevent deleting membership history or removing the final owner;
- `messages` is an immutable envelope with a conversation-local sequence,
  sender, kind and keyed integrity hash;
- `message_payloads` stores erasable text separately from the envelope;
- `conversation_pins` references an immutable message envelope, never copies
  its payload, and resolves erased content as unavailable at read time;
- `conversations.next_sequence` is allocated inside the same transactional D1
  batch as message append, with a unique index as the final backstop;
- SQL triggers enforce same-tenant references, active writable membership and
  append-only message envelopes;
- erased payloads are always returned as `null`, even if a malformed retention
  operation forgot to clear the underlying text field.

The integrity value is HMAC-SHA-256 over organization, message id and body. The
production key is an environment secret and absence fails closed. Local
development uses an explicitly non-production key only when local identity is
enabled. Erasure of a payload is a governed effect and will be introduced
through `ActionIntent`, never as an unguarded message deletion endpoint.

The attention model is a bounded, personal projection over governance:

- every proposed approval-required intent creates one immutable-history item
  per active human owner/admin, inside the same D1 batch as the intent and
  ledger event;
- `(organization, principal, dedupeKey)` prevents duplicate delivery while
  tenant/principal predicates prevent enumeration;
- opening an item can only transition `open -> seen` with compare-and-swap;
  no attention route can approve, reject or execute an intent;
- a completed governance decision resolves all addressee copies atomically;
  expired items are lazily reconciled to `resolved/expired` and disappear from
  the active projection without deleting their history; other terminal intent
  transitions use `resolved/superseded`;
- list reads are cursor-bounded and the global badge uses a count-only query;
- a governance deep-link requests its exact intent even outside the ordinary
  20-item window. A missing target disables every action and never falls back.

Evidence linkage lives in the artifact/provenance context; the attention row
does not copy evidence or erasable payloads.

Governed decision evidence uses a typed, provider-independent relation:

- `intent_artifact_evidence` links one exact artifact version to one
  ActionIntent as `basis` or execution-authored `outcome`;
- hash and byte size are pinned at insertion, while triggers enforce tenant,
  project, version, live-payload, phase and actor coherence;
- the basis set permits only a constrained pre-decision supersession and is
  frozen after the intent leaves `proposed`;
- ledger events contain only canonical lineage metadata. Markdown, titles,
  notes and conversation content are never copied into the chain;
- logical payload erasure leaves the evidence row and its ledger proof intact;
- a future evidence read model may union GitHub/deployment receipts, but the
  write model remains typed and foreign-key constrained.

Artifact reviews are a separate advisory write model:

- `artifact_reviews` binds one human opinion to one exact immutable version,
  including its content hash and byte size;
- verdict and reason are closed codes. There is no permanent free-text field,
  and a review does not mutate an artifact or authorize an effect;
- one reviewer has one active opinion per version. Re-review supersedes that
  row with compare-and-swap on the observed review id and preserves both
  versions of the opinion;
- producer approval requires the explicitly recorded `solo_owner_ack` and a D1
  trigger that proves no other eligible human contributor exists at commit;
  producers may request changes to their own work without that exception;
- the review transition and metadata-only `review.recorded` /
  `review.superseded` events commit in one batch;
- governed payload erasure preserves review history and proof but prevents a
  new review of unavailable content.

Cross-artifact supersession is a separate registry navigation graph:

- `artifact_supersessions` points one source artifact to one replacement while
  pinning the exact heads inspected at declaration;
- graph identity and active-outbound uniqueness use stable artifact ids, not
  version ids. Pins are evidence, and the tenant/status-scoped recursive walk
  rejects a cycle or an exhausted depth bound;
- only an active human owner/admin may declare or retract. The relation is
  metadata-only, uses closed reasons and does not require an `ActionIntent`;
- source content may be erased, while the target must be live and hash-verified
  at declaration. Equal source/target hashes are not a meaningful replacement;
- state transition and typed ledger event commit in one D1 batch. Ledger-head
  contention is a distinct retryable condition;
- later head advances make pins visibly stale but never mutate the relation,
  artifact recency, reviews or frozen decision evidence.

Decision-package export is an intent-rooted read projection, not another
artifact store:

- one static, intent-scoped D1 batch feeds a pure versioned Markdown renderer;
- exact response bytes receive an external SHA-256/package id and exclude
  requester time/identity plus unrelated organization events;
- erased, corrupt, budget-omitted and advisory-truncated content remains
  explicit while immutable evidence lineage is complete or fails closed;
- included ledger entry hashes are recomputed without claiming gap continuity,
  payload preimages, artifact registration or a signature;
- export is owner/admin-only bulk read, writes no governance event or payload
  copy and emits only a metadata-safe operational access record.

The artifact registry is a provider-independent evidence catalog:

- `artifacts` is the stable, immutable identity of a Markdown output and binds
  it to exactly one organization, project and work item;
- `artifact_versions` is append-only and records a strictly increasing version,
  producer, note, byte count, content reference and server-computed SHA-256;
- `artifact_payloads` is a separate erasable content store. Its immutable
  metadata survives an allowed body erasure so provenance does not collapse;
- artifact creation and version append stage the payload and persist payload,
  version and current-version advance in one D1 batch;
- compare-and-swap on `expectedVersion` rejects concurrent writers with `409`;
- database triggers reject cross-tenant/mismatched lineage, inactive producers,
  gaps, metadata mutation and version deletion;
- every content read recomputes UTF-8 byte length and SHA-256, returning an
  unavailable state instead of serving evidence whose body does not match its
  immutable envelope;
- `ArtifactPayloadStore` is the storage seam. The D1 adapter reuses an exact
  live body by `(organization, SHA-256)` after verifying byte size and literal
  content. Suspected collisions fail closed; a filesystem or R2 adapter can
  replace storage later without changing artifact routes or lineage;
- logical erasure is a high-risk governed effect, never a DELETE route. Impact
  is derived across every version carrying the tenant-scoped content hash;
- proposal and execution bind the reference count as an immutable precondition.
  Execution rechecks it in the same D1 batch that clears all live duplicate
  payload rows and appends the fenced receipt events;
- erasure authority is owner/admin only. With multiple eligible humans the
  proposer is excluded from approval; with one owner, explicit acknowledgement
  is required and the approval INSERT atomically proves no peer has appeared;
- a partial unique index permits one live semantic attempt while terminal
  attempts remain supersedable. Expiry and failure events are one-shot per
  intent/kind, including same-millisecond races.

The initial supported media type is literal `text/markdown` up to 256 KiB.
Rendering is intentionally non-executable. An artifact deep link identifies the
artifact, then the server re-derives its authorized work-item and project
context rather than trusting URL lineage.

Presence is an ephemeral projection over existing team-room conversations:

- one current lease per organization/principal stores only self-declared
  `available`, `focus` or `dnd`, an opaque session key, a fenced generation,
  optional room id and server-issued expiry. Compare-and-swap uses the session
  key and token together, including explicit release;
- a fresh client without the current token cannot replace a live lease.
  Takeover requires the explicit `takeover: true` command, increments the
  fencing generation and makes the previous client passive on its next write;
- `offline` is derived at read time and expired rows are deleted rather than
  archived. NexusOS never creates presence history or time-online analytics;
- only an active `room` membership can be published. Direct messages and
  handoffs are structurally invalid locations;
- room location is redacted unless the observer is also an active member;
- presence is an inert collaboration signal: it cannot mutate conversations,
  work or governance;
- humans self-declare presence through the UI. The storage contract is
  principal-agnostic so a future authenticated runner can maintain its own
  agent lease; agents remain honestly offline until that path exists;
- audio/video providers attach later through an optional media capability.
  The presence core has no WebRTC or external-service dependency.

The browser keeps the lease key and fencing token in tab runtime memory, not
shared or durable storage. Status preference is local and room preference is
session-scoped, but neither can grant ownership of a lease. The always-mounted
provider heartbeats using the server interval, polls the tenant-safe roster at
5 seconds while visible and 30 seconds while hidden, applies bounded backoff,
and attempts a fenced release on `pagehide`. `GET /api/presence` returns the
ephemeral roster; `PUT /api/presence/session` claims, renews or explicitly
takes over; `DELETE /api/presence/session` performs best-effort fenced release.

Realtime is an invalidation plane, never a data or authority plane:

- the Worker authenticates a socket and binds its trusted principal and
  organization to a private Durable Object request;
- one hibernating hub per organization stores no domain data and reconstructs
  routing only from WebSocket tags and serialized attachments;
- conversation publication resolves active conversation members, active
  workspace membership and active human principals from D1 at publish time;
- the hub iterates `principal:<id>` socket tags only for those authorized
  recipients, preventing both organization-wide scans and cross-conversation
  metadata delivery;
- public frames contain only a domain kind, opaque conversation/principal id
  when required, and an optional sequence hint;
- the browser accepts only exact frame shapes, coalesces invalidations and
  re-reads authorized HTTP projections;
- ping/pong, bounded full-jitter reconnect, periodic reauthorization and
  resync-on-connect close ordinary network gaps;
- only `LIVE` reduces polling. Probe, connect, reconnect and disabled states
  retain the original correctness cadence.

Attention and presence signals are scheduled only after a successful D1
mutation. A TTL-only presence renewal is suppressed; observable status, room,
release or mutation-path expiry cleanup publishes one roster invalidation.
Read-path cleanup never publishes, avoiding a refresh loop. Any notification
failure is absorbed after the authoritative outcome.

## ActionIntent contract

Minimum fields:

- `id`, `organizationId`, `projectId`
- `proposerId`, `actionType`, `targetRef`
- canonical `parameters` and `parametersHash`
- `preconditions` with observed target versions
- `riskTier`, `policyDecision`
- `requiredApprovals`, `approvals`
- `separationOfDuties`, optional `selfApprovalPolicy`
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

### S6.B1 identity bootstrap

The first runner slice is deliberately smaller than the full protocol:

```text
owner/admin issues 15m one-time token
  -> runner generates local Ed25519 keypair
  -> detached signed enrollment over exact request bytes
  -> atomic runner principal + registry + token consumption + ledger event
  -> signed outbound heartbeat with idempotent nonce replay
  -> derived liveness and immediate revocation
```

The runner id and principal id are deterministic over the high-entropy token
hash plus public key, with separate hash domains. This makes a lost enrollment
response recoverable without persisting the plaintext token. D1 enrollment
uses SQL guards and the foreign-key-safe order principal → runner → token →
ledger. A sequence collision retries the entire batch against a fresh ledger
head; partial identity without proof cannot commit.

Requests use raw Ed25519 keys and detached signatures. The signing envelope
domain-separates enrollment from heartbeat and binds uppercase method, exact
observed pathname, deployment-configured audience, strict timestamp, nonce and
SHA-256 of the one-read body bytes. Host/proxy headers never define the
audience.

Heartbeat nonce and exact response commit atomically with monotonic
`last_seen_at`. An exact nonce replay returns stored bytes and cannot refresh
liveness; changed bytes under the nonce fail. `pending`, `online`, `stale` and
`offline` are derived from server time, with `revoked` taking precedence.

The real capability label is limited to `operator_trust` identity and
connectivity. Sandbox, capabilities, leases, engines, execution, streaming and
outcome evidence remain roadmap until their later batches pass independently.

## Persistence

- D1/SQLite via Drizzle for relational control-plane state.
- Organization-scoped, content-addressed D1 text payloads behind
  `ArtifactPayloadStore`; R2 or a filesystem adapter is an optional scale
  implementation rather than a core dependency.
- Repository interfaces isolate domain services from runtime drivers.
- Migrations are forward-only and committed.
- Ledger serialization may use a per-organization coordinator after concurrency
  tests prove it necessary.

## Realtime

Phase 1 starts with HTTP commands and `afterSequence` polling against durable
storage. SSE can replace the transport without changing the sequence contract.
Presence is ephemeral and expires by TTL. Presence history and time-online
analytics are not collected.

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
