# NexusOS Core Local v1 architecture

## Runtime topology

```text
Browser on loopback
        |
        v
NexusOS control plane (vinext/Workerd)
        |
        +---- D1-compatible local SQLite state
        |
        +<--- signed HTTPS/loopback protocol --- Nexus Runner
                                                    |
                                                    +--- Claude Code CLI
                                                    |
                                                    +--- Codex CLI
```

Core Local is local-first. The control plane binds to loopback, migrations are
applied before readiness and all durable product state lives under the selected
state directory. The runner initiates outbound requests; the control plane
never receives provider credentials.

## Bounded contexts

| Context | Durable responsibility |
| --- | --- |
| Identity | organization, principals, memberships and local owner |
| Workspace | projects, teams, agents, objectives and work items |
| Collaboration | conversations, membership, messages, pins and handoffs |
| Presence | ephemeral self-declared room presence with TTL and fencing |
| Attention | personal actionable projections over governed records |
| Governance | ActionIntents, approvals, evidence and Decision Ledger |
| Artifacts | Markdown payloads, versions, reviews and supersession |
| Execution | runner enrollment, liveness, admission, leases and receipts |
| Operations | immutable work/agent/model/runner binding and publication |

All durable rows are organization-scoped. Mutable aggregate roots use integer
versions and compare-and-swap updates. Archives preserve history and enforce
dependency checks.

## First-run boundary

A normal empty start creates only the local organization identity boundary.
The first setup request then creates, in one database batch:

- workspace name;
- owner display name;
- first project and objective text;
- first team and mission.

The request is owner-bound and idempotently reconciled. No example project,
agent, message, output or runner is created in production mode.

## Work and agents

The work graph is provider-independent:

- projects own objectives and work items;
- teams belong to one project;
- agents are principals assigned to project teams;
- an agent definition freezes its role, model, memory scope and autonomy level;
- an optional model connection contains non-secret provider metadata only.

Jira, GitHub Issues and other trackers are not sources of truth for Core Local
v1 and are not required dependencies.

## Collaboration

Direct messages, team rooms and handoffs share one conversation envelope.
Conversation membership is the read/write authorization boundary. Messages
receive a conversation-local sequence and an integrity hash; payload text is
stored separately so governed erasure can make content unavailable without
rewriting the immutable envelope.

Presence is explicitly ephemeral. It records only the current self-declared
state and optional shared room location. It does not collect historical
time-online analytics.

## Governance and ledger

Consequential operations are represented as ActionIntents. Proposal, approval,
expiry and effect outcomes append ledger events. The ledger hash includes the
previous hash and canonical event fields.

Schema triggers enforce:

- no update, delete or replace of ledger entries;
- no update, delete or replace of approvals;
- immutable decision fields on ActionIntents;
- only the persisted approval, success, failure and expiry transitions;
- same-organization and active-principal references.

This protects the application database against accidental or ordinary SQL
rewrites. A local administrator who can replace database files or remove
triggers remains inside the trusted-host boundary; v1 does not claim WORM or
external anchoring.

## Runner trust boundary

Enrollment uses a 15-minute one-time token. The runner generates an Ed25519
keypair locally and signs enrollment, heartbeat, capability, engine inventory,
claim and completion requests. Nonces, request hashes and durable response
records make retries replay-safe.

Eligibility is derived from:

- active runner identity and recent heartbeat;
- current capability and engine reports;
- operator admission policy;
- matching runner/engine/version inventory;
- lease fencing and deadline rules.

The CLI executable is selected by an absolute path and canonicalized on the
runner host. Inventory is host-reported, not an attested sandbox guarantee.

## Operational loop

An owner creates an operation with exactly:

- active project;
- open work item;
- active agent assigned to a team in that project;
- active runner and explicit engine;
- user request.

Creation snapshots the agent name, role and model plus work item reference,
title and description. It atomically creates the engine run and immutable
operation binding under one idempotency key.

```text
create operation
  -> queued run bound to runner/engine/model
  -> explicit local-engine command with exact run_id
  -> signed claim and encrypted prompt retrieval
  -> bounded CLI process
  -> signed receipt and encrypted output excerpt
  -> owner refresh
  -> eligibility check
  -> atomic Markdown artifact + version + publication + ledger event
```

Claude output is validated as UTF-8 text. Codex `--json` output is parsed as a
closed JSONL protocol and only completed agent messages are projected. Raw tool
events, malformed JSONL, empty output, truncation, erasure or failed runs cannot
be published.

The operation form never overrides the agent model. The selected CLI is the
authority for whether that model identifier is accepted; an incompatibility is
recorded as a failed receipt and blocks publication.

## Secrets and erasure

- provider sessions remain in their CLIs;
- runner private keys remain in its project-local private state;
- enrollment tokens enter through a hidden prompt or deliberate stdin;
- prompts and excerpts use bounded AES-GCM envelopes;
- release archives exclude `.env*` except the empty template, `.nexusos`,
  `.wrangler`, `.openai`, dependencies and user state;
- permitted content erasure preserves immutable identity, hash and lineage.

## Distribution

The release is a deterministic source archive built from a tracked-file
allowlist. Its manifest binds product version, Git commit, migration head and
supported platforms. GitHub Actions validates macOS and Linux, generates SPDX
and CycloneDX SBOMs, checksums the artifacts and publishes attestations.

## Explicit v1 exclusions

Core Local v1 does not implement direct provider OAuth, audio/video meetings,
remote connectors, autonomous tool/MCP execution, streaming run output,
ambient work polling, automatic provider fallback, multi-user web login,
hostile-host isolation or externally anchored audit storage.
