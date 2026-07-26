# NexusOS Product Delivery Program

> Status: CONSENSUS
> Updated: 2026-07-26
> Delivery model: small batches, trunk-based development, continuous delivery

## 1. Outcome

NexusOS GA is an open-core Organization OS in which a signed-in user can:

1. Create organizations, projects and hybrid teams.
2. Assign a role, model connection, skills, memory policy and authority policy
   to each agent.
3. Start the day in a consolidated operational briefing.
4. Collaborate through direct messages, rooms and handoffs.
5. Create and track objectives, work items, runs, artifacts and releases.
6. Approve or reject consequential actions with evidence.
7. Verify an append-only decision and action ledger.
8. Run agents through provider APIs or authenticated local CLI pools.
9. Build guarded workflows, cron jobs and agent loops.
10. Connect GitHub, MCP servers and optional third-party systems.

GitHub Free may be required for the hosted baseline. Jira, Slack, paid GitHub
features and other proprietary SaaS are optional adapters and never core
dependencies.

### Delivery snapshot

| Capability | State on 2026-07-25 | Next shippable batch |
| --- | --- | --- |
| Build/CI/migrations | Complete baseline | Preview deployment evidence |
| Local identity and workspace | Complete local baseline | GitHub OAuth/session adapter |
| Project/team/agent CRUD | Complete baseline | Human membership administration |
| Objective/work-item graph | Complete baseline | GitHub mapping in Sprint 7 |
| ActionIntent and hash ledger | Complete simulated baseline | Policy catalog and production effects |
| Collaboration storage/API/UI | S4.B1–B5 complete | Revocation detach |
| Presence/inbox/realtime | Hibernating WebSocket + polling operational | Sprint 4 exit E2E |
| Runner/providers/GitHub | Not started | Sprint 6 onward |

Delivery may advance an independent vertical slice before every earlier sprint
exit is closed, but an incomplete exit remains visible and is a GA blocker. A
green later slice never hides missing hosted identity, production effects or
browser QA.

## 2. Program invariants

- Conversation, presence and media are inert channels.
- Every external side effect is represented by an `ActionIntent`.
- An intent is immutable after proposal, has a payload hash, preconditions,
  expiry, risk tier and idempotency key.
- Approval never comes from interpreting conversational text.
- Effects through Nexus connectors execute only through the effect gateway.
- The local runner is an explicit trust boundary. The product never claims to
  control effects performed outside its sandbox or gateway.
- Ledger events are append-only and hash chained.
- Personal or erasable content is stored outside the hash chain behind
  content-addressed references.
- Every capability is labeled `real`, `simulated`, `degraded` or `roadmap`.
- Optional integrations can improve a workflow but cannot make the core
  product unusable.

## 3. Runtime strategy

The system has two deployable planes:

- **Control plane:** web UI, identity, organization state, conversations, work
  graph, policies, ActionIntents, approvals, ledger, artifacts and operations.
- **Execution plane:** an open-source runner installed on a user-controlled
  machine or server. It hosts CLI sessions, sandboxes and local MCP tools and
  connects outbound to the control plane.

The control plane begins as a modular monolith. Domain code is framework-free.
D1/SQLite is the initial relational store behind repository contracts. R2 or a
filesystem adapter stores blobs. Payload-free invalidation uses a hibernating
WebSocket hub with polling as the complete fallback; D1 remains authoritative.

## 4. Small-batch operating model

A sprint is two weeks. A batch is one vertical change that can be reviewed,
deployed and rolled back independently in one or two days.

Batch limits:

- One user-observable outcome.
- Target at most 400 net production lines; mechanical extraction is exempt.
- One migration at most.
- No partially wired buttons presented as real.
- Feature flag when the end-to-end path is not yet safe for general use.

Every batch follows this lifecycle:

1. **Discover:** user problem, risk and baseline evidence.
2. **Frame:** hypothesis and measurable outcome.
3. **Design:** contract, threat model and failure states.
4. **Build:** smallest end-to-end path.
5. **Verify:** unit, integration, UI and negative tests.
6. **Review:** independent code/product review and adversarial check.
7. **Release:** preview, smoke, production promotion and rollback readiness.
8. **Learn:** telemetry, user feedback and ledgered decision.

## 5. Definition of Ready

A batch can start only when it has:

- problem statement and intended user;
- acceptance examples, including at least one failure example;
- affected domain and authority boundary;
- data migration and rollback assessment;
- observability and evidence requirements;
- test strategy;
- no unresolved architecture or security dissent.

## 6. Definition of Done

A batch is done only when:

- acceptance behavior is functional from UI to durable state;
- authorization and tenant isolation have negative tests;
- no external effect bypasses the ActionIntent gateway;
- migrations apply from an empty database and from the previous release;
- typecheck, lint, unit, integration, build and smoke are green;
- changed UI is keyboard accessible and responsive;
- logs contain correlation ids without secrets or private prompt contents;
- documentation and capability labels match reality;
- preview has been reviewed and rollback is documented;
- the batch decision and evidence are recorded.

## 7. Sprint roadmap

### Sprint 0 — Buildable foundation

Outcome: preserve the vision while making the repository safe to evolve.

Batches:

- Extract domain contracts and fixtures from the page.
- Introduce framework-free governance primitives.
- Add typecheck, domain tests and GitHub Actions CI.
- Establish architecture, business rules and QA evidence templates.
- Generate a D1 baseline migration and verify it locally.

Exit: existing vision smoke passes, governance tests pass and CI is reproducible.

### Sprint 1 — Identity and workspace core

Outcome: a known principal owns persistent organizations and projects.

Batches:

- Portable `Identity` contract and deterministic local development identity.
- Hosted GitHub OAuth adapter and secure session cookie.
- Organization, membership and project repositories.
- Persistent onboarding and project switcher.
- Tenant-isolation and session-expiry tests.

Exit: login, logout, create organization and create project survive refresh.

### Sprint 2 — Teams, agents and work graph

Outcome: real hybrid teams can be configured around measurable work.

Batches:

- Teams, human memberships and agent definitions.
- Agent role, model connection, skills, memory and autonomy configuration.
- Objective and work-item lifecycle.
- Kanban state transitions with optimistic concurrency.
- Archive and restore flows.

Exit: no core team/project entity depends on fixture data.

### Sprint 3 — Governance spine

Outcome: NexusOS proves that an effect cannot occur without governed intent.

Batches:

- ActionIntent state machine and policy result.
- Approval and rejection endpoints that never parse chat text.
- Canonical payload, SHA-256 ledger chain and verification command.
- Preconditions, expiry, semantic idempotency and per-step saga events.
- Deterministic simulator plus recorded contract fixtures.
- End-to-end flow: propose, approve, execute simulated effect, verify receipt.

Exit: tampering, replay, expiry, stale preconditions and unauthorized approval
are all rejected by automated tests.

### Sprint 4 — Collaboration and attention

Outcome: humans and agents collaborate without conflating speech and authority.

Batches:

- `S4.B1` unified direct, room and handoff schema plus tenant-safe HTTP API.
- `S4.B2` persistent conversation list, composer and message timeline UI.
- `S4.B3` membership CRUD, archive and pinned-context lifecycle.
- `S4.B4` governed attention items linked to exact intents; evidence linkage is
  deferred to Sprint 5 provenance.
- Presence sessions with TTL, DND and privacy limits.
- Hibernating WebSocket invalidation with sequence-based HTTP backfill and
  complete polling fallback.

Exit: conversations persist and an approval can only occur in the dedicated
intent flow.

`S4.B1`, `S4.B2`, `S4.B3`, `S4.B4` and `S4.B5` are complete. The envelope is
append-only, payload content is separately erasable, integrity uses a keyed
per-message MAC, and
conversation-local sequence allocation is serialized in D1. The UI exposes
real DMs, rooms and handoffs, isolates drafts by conversation, reconciles by
sequence and uses visibility-aware polling with bounded backoff. Payload
erasure execution is deferred to a governed `ActionIntent`; there is no direct
destructive HTTP shortcut.

Membership changes are soft and versioned, archive/reopen uses conversation
CAS, and pins reference message envelopes without copying erasable payloads.
The lifecycle UI supports member roles, archive/reopen and pin/unpin from the
active conversation, including an accessible responsive details drawer. Real
browser validation covered the reversible lifecycle paths; the D1 gate also
covers an archived seeded conversation to keep local bootstrap idempotent.

The attention projection now creates one item per active human owner/admin in
the proposal transaction, isolates reads by tenant and principal, and supports
only the CAS transition `open -> seen`. Approval resolves every addressee copy
atomically; expiry uses a distinct retained resolution. Lists are bounded by a
stable cursor, the sidebar uses a count-only query, and exact intent focus
works beyond the ordinary governance window without fallback. Browser
validation covered proposal, badge, selection, seen, exact deep-link, approval,
empty state and mobile layout. Evidence references remain Sprint 5 work rather
than being copied into attention.

Presence now uses a single ephemeral D1 lease per organization/principal with
server TTL, fencing and explicit takeover. Tokenless clients cannot silently
replace a live lease; stale renew/release fails closed. The roster derives
offline, deletes expired rows instead of retaining history, redacts room
location outside shared active membership and never publishes DMs or handoffs.

`S4.B6` now has an operational server transport and browser client. One
hibernating Durable Object hub per organization fans out payload-free
conversation, attention and presence invalidations. Every publish resolves
recipients from D1 at send time; the hub iterates only sockets tagged for those
authorized principals. The browser holds one organization socket, strictly
validates frames, coalesces bursts, resynchronizes after reconnect, suspends
reads while hidden and retains full-rate polling outside `LIVE`. Message and
attention watchdogs run at 60 seconds while live; presence remains at 15
seconds so an ungraceful lease expiry becomes visible promptly. Push is
feature-flagged and the product remains fully usable when it is absent.
The always-mounted UI provider supports status, heartbeat, visibility-aware
roster polling, room enter/leave, passive-tab recovery and direct navigation
from a real room to its persistent chat. Audio/video remains an optional
roadmap capability. Browser validation covered status, room/chat flow,
passive/takeover behavior and the 390x844 layout without horizontal overflow.

### Sprint 5 — Artifacts, outputs and provenance

Outcome: every useful output is addressable and traceable.

Batches:

- Artifact and artifact-version registry.
- Content-addressed blob adapter and erasable payload references.
- Lineage from objective to work item, run, artifact and outcome.
- Output review and supersession.
- Exportable Markdown decision package.

Exit: a reviewer can navigate from an output to producer, evidence and decision.

### Sprint 6 — Runner and CLI execution pool

Outcome: one local runner can safely execute a governed task.

Batches:

- Runner enrollment with one-time token and device key.
- Versioned lease protocol, heartbeat, fencing token and outbox replay.
- Sandbox/capability profile and explicit trust-boundary UI.
- Claude Code CLI adapter or Codex CLI adapter, selected by contract viability.
- Streaming run events and cancellation.
- Chaos tests for disconnect, duplicate lease and zombie completion.

Exit: a local run completes, streams evidence and cannot claim a stale lease.

### Sprint 7 — GitHub delivery engine

Outcome: GitHub Free becomes the default work and release motor.

Batches:

- GitHub App/OAuth installation and scoped repository access.
- Issues and PRs mapped to the Nexus work graph.
- Check runs and deployment statuses as evidence.
- Intent-gated PR creation, review request, merge and deployment promotion.
- Effect receipts, webhook reconciliation and rate-limit behavior.

Exit: a governed work item reaches a real PR and deployment record with lineage.

### Sprint 8 — Provider broker and routing

Outcome: agents can use model providers without coupling identity to one vendor.

Batches:

- Provider and model catalog.
- OAuth adapter where supported and local CLI connection otherwise.
- Encrypted credential references; secrets never appear in D1 logs.
- Per-agent connection assignment, budget and usage accounting.
- Ordered fallback chain with explicit semantic-degradation event.
- Health, expiry and reconnection UX.

Exit: at least one API/OAuth path and one CLI path execute through the same run
contract.

### Sprint 9 — Workflows, loops and schedules

Outcome: work can continue autonomously within explicit stopping rules.

Batches:

- Versioned workflow definition and run state machine.
- Manual, cron and event triggers.
- Retry, timeout, dead-letter and compensation behavior.
- Agent loop budgets, maximum steps and stop conditions.
- HITL pause/resume.
- Automation operations view and replay.

Exit: a scheduled workflow completes or stops deterministically with full
evidence and no orphaned effect.

### Sprint 10 — Skills, MCP and governed memory

Outcome: capabilities and context are reusable without silent privilege growth.

Batches:

- Skill registry with version, provenance and requested capabilities.
- MCP server registry and tool discovery.
- Per-agent allowlist and policy evaluation.
- Working, episodic, project and organizational memory scopes.
- Promotion, supersession, retention and deletion policy.
- Prompt/context assembly report with token and evidence sources.

Exit: adding a skill or memory cannot expand authority without a recorded policy
change.

### Sprint 11 — Operations, rooms and release intelligence

Outcome: NexusOS is the credible start-of-day operational surface.

Batches:

- Today briefing from real projects, runs, decisions and incidents.
- Team Rooms presence and drop-in flow with anti-surveillance defaults.
- Release health, last deployed version and rollback history.
- SLOs, traces, cost, budget and audit dashboards.
- Notification routing and quiet-hours policy.
- MediaSession contract and provider hook; audio/video remains post-GA.

Exit: the user can understand current state, risk and next decisions without
opening another system.

### Sprint 12 — Security, resilience and GA

Outcome: a documented, supportable and recoverable NexusOS v1.0.

Batches:

- Threat-model closure and OWASP review.
- Backup, restore, migration rehearsal and disaster recovery.
- Load, soak, chaos and multi-tenant isolation tests.
- WCAG 2.2 AA audit and responsive visual regression.
- Installer/runbook for the open-source runner.
- Upgrade, rollback, incident and data-export runbooks.
- Full QA, beta feedback closure and release candidate.

Exit: all GA gates below pass.

## 8. GA release gates

- At least 98% of the approved QA scenarios pass.
- 100% of critical security, governance and tenant-isolation scenarios pass.
- Zero open P0 or P1 defects.
- Ledger verification succeeds from genesis to current head.
- Backup restore is rehearsed with measured recovery time.
- Runner reconnect and replay survive a 30-minute network interruption.
- External effects have intent, receipt and evidence coverage.
- Core workflows operate without Jira, Slack or any paid GitHub feature.
- Capability labels have no known false claims.
- Two independent reviewers converge or dissent is explicitly accepted.

## 9. Delivery metrics

- Lead time from accepted batch to production: under two working days.
- Deployment frequency: at least three promotions per week during build.
- Change failure rate: under 10%.
- Mean rollback time: under five minutes.
- Escaped P0/P1 defects: zero.
- Policy bypass rate: zero.
- Orphaned or unreconciled effects: zero.
- Percentage of outputs with complete lineage: at least 99%.
- User time to first project and team: under ten minutes.

## 10. Explicit post-GA roadmap

Native audio/video infrastructure, spatial rooms, external transparency logs,
advanced enterprise federation and third-party marketplaces are not GA blockers.
GA includes their stable contracts and extension points, not simulated claims
that those systems already exist.
