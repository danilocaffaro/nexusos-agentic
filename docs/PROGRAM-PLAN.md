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

| Capability | State on 2026-07-26 | Next shippable batch |
| --- | --- | --- |
| Build/CI/migrations | Complete baseline | Preview deployment evidence |
| Local identity and workspace | Complete local baseline | GitHub OAuth/session adapter |
| Project/team/agent CRUD | Complete baseline | Human membership administration |
| Objective/work-item graph | Complete baseline | GitHub mapping in Sprint 7 |
| ActionIntent and hash ledger | Complete simulated baseline | Policy catalog and production effects |
| Collaboration storage/API/UI | Sprint 4 complete | Runner handoff events |
| Presence/inbox/realtime | Sprint 4 complete | Membership-admin socket hygiene |
| Artifacts/outputs/provenance | Sprint 5 complete | Runner outcome receipts |
| Runner/providers/GitHub | Sprint 6 in progress; S6.B1 complete | Versioned lease and fencing |

Delivery may advance an independent vertical slice before every earlier sprint
exit is closed, but an incomplete exit remains visible and is a GA blocker. A
green later slice never hides missing hosted identity, production effects or
browser QA.

### Parallel delivery topology

NexusOS uses two implementation lanes only when their production file and
contract sets are disjoint:

- **Team A — critical path:** the next dependency-bearing runtime slice.
- **Team B — independent slice:** a bounded dark or vertical batch based on a
  frozen interface and an explicit file allowlist.
- **Integration guard:** an independent reviewer that freezes interface
  hashes, audits changed-file intersection and dry-merges candidate commits.

Every team works from an isolated worktree or fresh checkout. Tests and lint
remain sequential inside each checkout; worktrees and CI jobs may run in
parallel. A candidate is frozen only after focused tests, the complete
pipeline and an exact-model review with P0=0/P1=0. The critical-path commit is
integrated first, then the independent commit is rebased or cherry-picked and
the complete combined pipeline runs again. No test counts are inferred or
added across branches.

Parallel work stops immediately if teams touch an unapproved common
production file, a frozen contract changes, a dark batch activates an effect
or capability label, either independent pipeline fails, the combined pipeline
fails, or the review returns a P0/P1. `docs/PROGRAM-PLAN.md` may be a declared
documentation hotspot, but its merge must preserve both sprint records.

This topology was validated by S6.B4.4a4.4 and S7.B2: both worktrees passed
independently, integrated without a production-file conflict and then passed
the combined 238-unit, 197-runner, 38-migration, seven-integration, build,
smoke, lint and zero-vulnerability audit gate.

The next parallel pair, S6.B4.4a5.2 and S7.B3, also passed independently.
Their changed-file intersection was exactly this declared plan hotspot; a
synthetic merge-tree and blob audit proved the runtime, contract, test and
fixture sets disjoint. After integration, the combined 274-unit, 205-runner,
38-migration, seven-integration, build, 2-smoke, lint and
zero-vulnerability audit pipeline passed.

The third parallel pair is S6.B4.4a5.3 and S7.B4. Team A owns only the dark
engine serve-cycle boundary and recovery hardening; Team B owns only the dark
GitHub installation snapshot provider port. Their production, contract and
test allowlists are disjoint. The integration guard verified the A-first
synthetic and real trees, preserved all 12 frozen blobs and found only this
declared plan hotspot in common. After integration, the focused 75-test engine
and 46-test GitHub matrices and the combined 264-unit, 226-runner,
38-migration, seven-integration, build, 2-smoke, lint and
zero-vulnerability audit pipeline passed.

The fourth parallel pair is S6.B4.4a5.4 and S7.B5. Team A owns the public,
claim-free heartbeat/recovery serve command and its bounded completion HTTP
effect; Team B owns real/current, read-only GitHub App installation discovery.
Their production, contract and test allowlists are disjoint. Both inherit only
frozen boundaries from the third pair, and this plan is their sole declared
documentation hotspot. The integration order remains critical-path Team A
first, then Team B, followed by the complete combined pipeline and an
independent merge/frozen-blob audit.

The integration guard verified exactly one shared path, this declared plan
hotspot, and no production, contract or test overlap. The A-first synthetic
tree and real cherry-pick both produced tree
`01250e835637ac78e4455647945a372a441563a5`; the plan blob also matched
exactly, all inherited runner/GitHub frozen blobs passed, and no manual
resolution was needed. Post-integration focused gates passed 139/139 for
serve/recovery and 64/64 for GitHub B1-B5. The complete combined pipeline
passed 282 unit, 262 runner, 38 migration/preflight, all seven integrations,
build, 2/2 smoke, lint, diff hygiene and a zero-vulnerability production
audit. The live GitHub gate remains an honest credential-free `SKIP` with
exit 2; it is not substituted with loopback evidence.

The fifth parallel pair is S6.B4.4a5.5a and S7.B6. Team A owns only the
schema-free engine-claim contract and injected HTTP effect under `runner/`;
Team B owns only the dark, pure GitHub Issue/PR work-projection boundary.
Their production, contract, test, fixture and release-evidence allowlists are
disjoint. This plan is the sole declared common path, with Team A restricted
to the Sprint 6 hunk and Team B to the Sprint 7 hunk. Integration remains
critical-path Team A first, then Team B, followed by frozen-blob verification
and the complete combined pipeline.

The independent guard confirmed exact seven-path and six-path allowlists,
with this plan as the only shared path. Its A-first synthetic integration found
one documentation-only conflict in the pair-introduction paragraph. The real
resolution was committed on main as `a7c0a51`, preserved Team B's paragraph
and both disjoint sprint hunks, and produced the guard's exact pre-evidence tree
`13ac7e9958938ec012040cd16d7ef71be140c576`. All eight frozen runner blobs and
14 frozen GitHub blobs remained exact. Post-integration focused gates passed
98/98 for claim/prompt and 26/26 for delivery/projection. The complete combined
pipeline passed 298 unit, 360 runner, 38 migration/preflight, all seven
integrations, build, 2/2 smoke, lint, diff hygiene and a zero-vulnerability
production audit. The guard's documentation-only P2 was closed by the exact
tree-matched resolution; P0/P1 remained zero.

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

Sprint 4 is complete. Network tests prove that a revoked conversation member
receives no later frame even while its organization socket remains open and
cannot fetch or reconnect to that conversation. Conversation-specific detach
is therefore not part of the protocol. When workspace-membership
administration is introduced, that batch must close the revoked principal's
organization sockets as connection hygiene in addition to the existing D1
fail-closed authorization.

### Sprint 5 — Artifacts, outputs and provenance

Outcome: every useful output is addressable and traceable.

Batches:

- Artifact and artifact-version registry.
- Content-addressed blob adapter and erasable payload references.
- Lineage from objective to work item, run, artifact and outcome.
- Output review and supersession.
- Exportable Markdown decision package.

Exit: a reviewer can navigate from an output to producer, evidence and decision.

`S5.B1` is complete. A workspace member can create a Markdown output from a
real work item, append immutable versions with compare-and-swap, inspect literal
content and history, copy an addressable deep link and recover from a concurrent
writer without overwriting it. Artifact identity, project/work-item lineage,
producer, version, byte count and server-calculated SHA-256 are durable in D1.
Payloads live in a separate erasable table behind a storage port, while database
triggers enforce tenant-coherent references, sequential versions, active
producers and append-only history. Reads recompute byte length and SHA-256 and
fail closed when stored evidence is inconsistent.

`S5.B2` is complete. Payload staging now performs organization-scoped,
content-addressed reuse in D1 and verifies exact bytes before reuse; a hash/size
or body collision fails closed. Logical payload erasure is available only as a
high-risk `ActionIntent`: owner/admin proposal, human approval bound to the
parameter hash, blast-radius refcount precondition, fencing, receipt and
one-shot ledger events. Two eligible approvers enforce separation of duties.
A true solo owner must complete an explicit acknowledgement, and the same D1
transaction re-checks that no peer became eligible before committing approval.
Terminal attempts can be safely superseded while only one live semantic attempt
exists.

`S5.B3` is complete. An active owner/admin/member can link an exact immutable
artifact version as `basis` while an ActionIntent is open. The row pins hash
and size, is tenant/project coherent by trigger, enters the chain only as a
metadata envelope and freezes when the decision advances. Pre-decision
supersession preserves history; concurrent requests have one winner. Governed
payload erasure leaves the decision evidence and verified chain intact.
`outcome` is schema-reserved for a non-human execution transaction, with no
human route and no premature Sprint 6 runner.

`S5.B4a` is complete. Active human contributors can record one advisory,
version-pinned review with a closed verdict/reason vocabulary and no permanent
free text. Re-review preserves the prior opinion and atomically appends
metadata-only supersession and recording events. A producer can request
changes, while approval requires either an independent human or an explicitly
acknowledged sole-owner exception revalidated by D1 at commit. Governed payload
erasure retains review proof and blocks new blind reviews.

`S5.B4b` is complete. Active human owners/admins can declare one typed,
cross-artifact head supersession with artifact-id cycle safety, exact observed
head pins, target-payload verification, retractable metadata-only history and
atomic ledger proof. Erased sources remain truthfully navigable, live targets
are required at commit, and neither declaration nor retraction mutates artifact
identity, versions, recency, reviews or decision evidence.
`S5.B5` is complete. An active human owner/admin can preview and download a
deterministic Markdown package rooted in one decided `ActionIntent`. The
package includes exact evidence versions, producer/work-item lineage,
version-pinned reviews, artifact supersession and bounded relevant ledger
references. Exact UTF-8 bytes are covered by an external SHA-256,
`Repr-Digest`, strong fingerprint ETag and preview-to-download CAS. Erased,
corrupt, size-omitted and advisory-truncated data is disclosed without
persisting a package/payload copy or writing a governance event. The UI
recomputes the hash before showing literal Markdown or downloading it.

Sprint 5 is complete. Automated, adversarial Opus and browser gates prove the
exit path from output to producer, immutable evidence and governed decision.
Filesystem/R2 payload adapters remain optional scale implementations behind the
same port; they are not dependencies of the NexusOS core.

### Sprint 6 — Runner and CLI execution pool

Outcome: one local runner can safely execute a governed task.

Batches:

- `S6.B1` runner enrollment with one-time token, Ed25519 device identity,
  signed heartbeat, revocation and explicit `operator_trust`. **Complete.**
- `S6.B2` versioned lease protocol, fencing token and durable outbox replay.
  **Complete.**
- `S6.B3` host-declared capability profiles, server-owned admission and a
  truthful trust-boundary UI. **Complete.**
- `S6.B4` Claude Code CLI and Codex CLI adapters behind `ExecutionEngine`.
- `S6.B5` streaming run events, cancellation and outcome receipts.
- `S6.B6` chaos tests for disconnect, duplicate lease and zombie completion.

Exit: a local run completes, streams evidence and cannot claim a stale lease.

`S6.B1` design is frozen after Fable/Opus adversarial review. The batch proves
only machine enrollment, possession of a device key, revocation and recent
outbound connectivity. It does not yet lease or execute work. One token can
create at most one runner; a lost success response is recoverable with the same
key; heartbeat replay is byte-idempotent; lifecycle state and typed ledger
proof commit atomically. The management surface must display the full
operator-trust boundary before this batch may be called complete.

`S6.B1` passed on 2026-07-26. The reference Node 22 runner performs real local
key generation, detached signed enrollment and heartbeat; the authenticated
management UI issues/revokes one-time tokens, lists derived liveness and revokes
runners. Fable/Opus architecture review, two Opus implementation passes,
automated regression, real CLI acceptance and desktop/mobile browser QA are
recorded in `docs/qa/s6-b1/`. This pass does not advance the Sprint 6 exit:
`S6.B2` passed on 2026-07-26. The closed diagnostic now proves signed claims,
renewal, monotonically fenced reassignment, revocation-before-replay,
crash-safe semantic outbox replay and exactly one current outcome without
running user work. The final Opus review returned `PASS` with zero P0/P1 after
closing revocation/renew/cancellation races. Execution, sandbox and streaming
remain roadmap; `S6.B3` is the next shippable batch.

`S6.B3` is split into seven reversible batches: CI parity and frozen
contracts; append-only report storage; signed durable reporting with outbox-v1
compatibility; static local probes; one-active-lease convergence; assigned
diagnostic plus declaration-based admission; and truthful trust-boundary UI.
Only capability reporting and server admission may become real. OS sandbox
isolation and execution remain roadmap throughout S6.B3.

`S6.B3.1` passed on 2026-07-26. GitHub CI now executes the real runner suite;
canonical capability-report and outbox-v1/v2 contracts are frozen with strict
privacy bounds, body/envelope identity binding and rollback-safe sibling
storage. The live v1 reader uses the shared validator. No endpoint, persistence
or product capability was activated; append-only report storage is the next
batch.

`S6.B3.2` passed on 2026-07-26. It adds tenant-bound append-only
report/evidence/nonce storage, a pure keyset-paginated history GET and a bounded
single-query latest declaration projection. Migration, integration, build,
lint, audit and schema-drift gates are green; the Opus delta gate returned
`PASS` with zero P0/P1 and authorized commit. It activates no report mutation
or runtime capability; B3.3 remains responsible for signed submission, bounded
mutation-time cleanup/compaction and outbox-v2 delivery.
The nonce deletion affordance and compaction index are intentionally dark until
B3.3. `capabilityProfiles` remains `roadmap` until the truthful UI batch B3.7
passes its own product and accessibility gates.

Before B3.3 activates writes, its entry gate must make the monotonic
receive-time lookup use the organization/runner history index and guard nonce
cleanup with a bounded oldest-first delete. The B3.2 empty-cursor and defensive
projection-limit P2 polish remain tracked but do not overstate or weaken the
current read-only capability.

`S6.B3.3` is split into two reversible commits. B3.3a, the signed server
mutation plane, passed full regression and an independent Opus gate with zero
P0/P1 on 2026-07-26. B3.3b adds sibling-directory outbox-v2 durability and the
honest pre-probe CLI. Neither slice changes roadmap labels; capability
detection remains owned by B3.4.

`S6.B3.4` passed on 2026-07-26. The reference runner now emits bounded,
privacy-safe host declarations from a fixed local probe registry and preserves
all-unknown hosts as usable. `S6.B3.5` then passed its operator preflight,
cross-run lease convergence, revocation and one-active-lease storage gates.

`S6.B3.6` passed on 2026-07-26 in four reversible commits: governed policy,
additive assignment storage, shared claim-time admission and the strict public
assigned-run route plus pure reads. Unassigned B2 bytes remain frozen;
assignment never falls back, capability eligibility is evaluated only at
claim, and overdue reads derive expiry without mutation.

`S6.B3.7` passed on 2026-07-26 through six UI/release slices after the schema
hygiene and shared-oracle foundation. The Runners workspace now exposes
bounded signed-declaration history, the governed policy read/editor,
race-safe pool/assigned diagnostic creation and truthful claim facts.
`capabilityProfiles` is `real` for the reporting/admission control plane;
every report remains `hostReported` and unverified, while arbitrary execution,
Sandbox and Streaming remain `roadmap`. Full regression, a static truth-label
gate, Opus release review and 1440/390 browser evidence close the batch.
`S6.B4` is next.

`S6.B4` is split into six reversible batches: dark engine contracts/port;
local executable configuration plus signed readiness inventory; additive
engine-run and encrypted-prompt control plane; supervisor/effect protocol;
real Claude Code/Codex adapters; and truthful UI/release. The engine is
optional at platform level and assigned-only at run level. Provider login and
credentials remain on the runner host. B4 adds no Jira, paid API or
vendor-specific project-system dependency.

The B4 architecture gate is accepted after Fable design review and a final
Opus 5 delta `PASS` with P0=0/P1=0. B4.1 and every B4.2 slice are complete:
dark contracts, the pure port, canonical local configuration, signed
append-only readiness inventory, real bounded metadata/auth probes and
rollback-safe outbox-v3 passed their complete release pipelines and final
Opus gates with P0=0/P1=0. B4.3 is implementation-ready after a Fable
`PASS/GO`, P0=0/P1=0 delta that preserved the accepted ADR's exact keyring,
AAD, route, event, deadline and sweep contracts. B4.3a through B4.3g are
complete. B4.4a1 added dark immutable receipt and encrypted excerpt storage.
B4.4a2 then activated the signed, effect-once server completion transaction
and receipt-bound event/ledger proof. Its full pipeline passed with final
Opus `PASS/GO`, P0=0/P1=0. No runner caller or provider spawn is active;
B4.4a3 extends the frozen outbox-v3 substrate with exact pending and scrubbed
terminal `engine.complete` declarations, a mirrored canonical parser and the
closed future HTTP classification. It adds no caller, command or provider
spawn. Its full pipeline and final Opus gate passed with P0=0/P1=0. B4.4a4 is
split into four reversible commits. B4.4a4.1 adds only the dark append-only
attempt journal and pure recovery table; it has no command, network or spawn.
Its complete release pipeline and final Opus delta passed with P0=0/P1=0.
B4.4a4.2 adds only the internal signed completion sender and deterministic
recovery drain. It has no producer, command, prompt, supervisor or spawn, and
its corrected Opus gate passed with P0=0/P1=0. B4.4a4.3 adds the dark,
crash-safe detached supervisor,
mutually authenticated bounded local protocol, effect-once spawn/input gates,
exact child identity, deterministic scratch ownership and durable result
replay. It exposes no public command or provider execution path. Real
executable, crash, reconnect, overflow, PID-reuse, inspection and abandon
tests passed; the complete release pipeline and final Opus delta passed with
P0=0/P1=0. B4.4a4.4 closes the dark journal/outbox recovery transaction with
deterministic completion identity, strict cross-store correlation, bounded
single-writer recovery, terminal settlement and crash-safe retention. Its
focused adversarial suite and final Opus gate passed with P0=0/P1=0.
B4.4a5 is split into five reversible commits. B4.4a5.1 adds only opaque,
borrowed state-lock ownership so a future process-lifetime owner can invoke
the dark coordinator without self-deadlock; it adds no caller and does not
solve or permit HTTP under the state lock. B4.4a5.2 closes inherited recovery
hardening and rollback gates; B4.4a5.3 adds the fair pure serve-cycle machine
and separates filesystem preparation/finalization from HTTP; B4.4a5.4 wires a
public heartbeat/recovery serve command without claim; B4.4a5.5 adds governed
claim/prompt/supervisor opt-in. Execution remains `roadmap` through all five
and may become `real` only at the B4.5 product/evidence gate.

B4.4a5.5 is further split into activation-safe slices. B4.4a5.5a adds only
dark claim/prompt contracts, canonical journal producers and bounded total
HTTP effects. B4.4a5.5b is divided again into B2a additive prestart records,
B2b absolute HTTP/readiness/fingerprint/cancellation contracts and B2c public
composition. B2c alone may wire explicit
`serve --run <runId> --engine <engine>` activation under the existing single
process owner and with at most one live attempt. There is no polling or
ambient work discovery in these slices.

B4.4a5.1 through B4.4a5.4 are complete. The second slice deliberately extends the
local v1 settlement vocabulary with the already-terminal outbox state
`abandoned`, settles it without completion HTTP and proves that rollback to
the immediately preceding reader quarantines rather than redeclares it. It
also bounds and quarantines hostile staged cleanup while propagating storage
failures as infrastructure errors. Fable accepted the explicit v1 evolution;
the final Opus and independent integration-guard gates returned GO with
P0=0/P1=0. The complete 251-unit, 205-runner, 38-migration,
seven-integration, build, smoke, lint and zero-vulnerability audit pipeline
passed. B4.4a5.3 adds the dark fair serve-cycle boundary: effects receive an
exact request descriptor but no state directory or lock capability, run
outside the borrow and finalize only after fresh durable revalidation.
Recovery remains bounded at 32 attempts and 16 effects, yields between
nonterminal effects and suppresses terminal pruning until every correlated
journal is settled. The combined legacy drain remains non-activatable. Its final Opus
delta and independent guard gates returned GO with P0=0/P1=0. B4.4a5.4
consumes only the effect-only cycle and adds a bounded, normalizing HTTP
adapter. It now exposes `nexus-runner serve`: one process-lifetime
owner runs independent heartbeat and recovery loops, invokes only the
effect-only cycle and bounds native completion responses to a fixed 64 KiB
buffer. It does not claim work, read prompts or spawn a provider. Fable and
the independent adversarial oracle returned GO with P0=0/P1=0 after the
durable-auth and competing-stop races were made arrival-order independent.
The final Opus delta returned PASS/GO with P0=0/P1=0 after actionable fatal
diagnostics and the SIGTERM-plus-durable-403 intersection were closed.
B4.4a5.5a is complete. It derives a claim operation identity in a domain
separate from completion, validates the server descriptor canonically, rejects
expired or under-budget leases after the claim response and commits exact
`claimed`/`starting` journal records. Prompt delivery stays outside journals
and logs: one fixed 8,193-byte scratch is bounded, copied once on success and
zeroed on every path; failure always returns `promptBuffer: null`. Both HTTP
effects retain only a closed server-error vocabulary, normalize transient edge
failures without exposing response text and are total against hostile
objects, streams, allocator seams and cancellation/release failures.
No public command imports either module, active runner hashes are unchanged
and execution remains `roadmap`.

B4.4a5.5b2a and B2b are complete. B2a adds the rollback-safe prestart
rejection, cancellation, abandonment and spawning records without execution.
B2b adds one absolute claim/prompt/renew I/O deadline, fresh version/capability/
auth readiness, supervisor protocol v2 with executable fingerprint
revalidation and durable renewal cancellation. Both physical previous-reader
rollback gates return GO.

B4.4a5.5b2c is complete. Runner `0.6.0` accepts only an explicit
`--run/--engine` pair, composes claim, prompt, renew, fresh readiness, durable
spawn intent and the recoverable supervisor under the single serve owner, and
never polls for ambient work. Lease expiry and the complete run deadline bound
every retry and provider lifetime. Supervisor protocol v3 binds the lease
tuple into spawn and monotonic renewal controls, requires an authenticated
acknowledgement before parent adoption and keeps the hard watchdog inside the
detached supervisor. Protocol-invalid server shapes exit 76 without
fabricating truth. V2 supervisors must be drained before upgrade; any residual
`sup2:` journal is attention-only and cannot launch or adopt a provider. The
version-pinned Claude/Codex recipes disable
tools, MCPs, web and agentic feature surfaces, and a production-adapter
acceptance canary proves the observed sentinel-only behavior with no marker
disclosure/mutation, emitted tool action or filesystem side effect. The B4.4
candidate passed 298 unit, 477 runner, 38 migration/preflight, all seven
integrations, build, 2/2 smoke, lint, diff hygiene, both rollback gates and a
zero-vulnerability production audit.

B4.5 is complete. The product now projects authoritative assigned
runner/engine options, creates one encrypted engine run through a
tenant/requester-bound idempotency and reconciliation proof, lists and inspects
stored lifecycle/receipt truth and reads governed excerpts only on explicit
owner demand as opaque Base64URL. The UI never retries or falls back to another
runner/provider after an ambiguous outcome. Assigned one-shot Claude Code CLI
or Codex CLI execution is now `real`; general tools, workspace mutation,
streaming UI and OS-level provider isolation remain `roadmap`.

Sprint 6 technical-debt gates:

- before GA security sign-off, add storage-level `UPDATE`/`DELETE` denial for
  `ledger_entries`. Until then the Decision Ledger is application-append-only
  and tamper-evident through its hash chain, but not storage-immutable.

The previous one-active-lease debt was closed by `S6.B3.5` with storage-level
convergence and preflight reconciliation.

### Sprint 7 — GitHub delivery engine

Outcome: GitHub Free becomes the default work and release motor.

`S7.B1` establishes the schema-free, dark delivery-domain boundary: stable
installation/repository identity, strict issue/PR/check/deployment evidence,
closed lineage edges and the GitHub `ActionIntent` action/target vocabulary.
It adds no GitHub caller, credential, route, webhook, storage, UI or effect
execution. The next independently reversible batch is scoped installation and
repository authorization; no evidence is called durable or real until a later
adapter and storage slice crosses this contract.
The final exact-model Claude Opus 5 gate passed `GO` with P0=0/P1=0/P2=0;
S7.B1 is complete and every GitHub capability remains `roadmap`.

`S7.B2` adds the versioned, per-repository GitHub App installation scope and a
pure fail-closed authorization predicate for all six frozen effect intents.
Fable selected a fine-grained GitHub App permission boundary instead of broad
classic OAuth scopes; GitHub login remains identity-only at this layer. The
official endpoint matrix requires `issues:write`, `pull_requests:write`,
`contents:write` for merge and `deployments:write`. The exact Opus 5 delta gate
passed `GO` with P0=0/P1=0 after closing inherited-array iterator confusion.
The batch contains no credential, caller, route, port, persistence, webhook or
effect, so every GitHub capability remains `roadmap`.

`S7.B3` adds one async read-only installation-scope source port and an
in-memory fixture adapter. The adapter owns an exact `0..500` repository
snapshot, normalizes it through the frozen B1/B2 parsers and proves membership
by installation and repository ID. `repositorySelection: all` is descriptive,
not ambient authority: absent repositories still fail closed. The fixture is
caller-supplied and makes no freshness or durability claim. There is still no
GitHub caller, credential, route, webhook, persistence or effect, so every
GitHub capability remains `roadmap`.

`S7.B4` adds a versioned dark page envelope, a one-method injected transport
seam and a strict multipage installation-snapshot aggregator. The transport
returns untrusted documents; the aggregator copies exact envelopes, enforces
invariant installation facts and totals, opaque cursor progress, at most 500
calls and an exact `0..500` repository result, then delegates the completed
fixture-v1 snapshot to frozen B3. There is no transport implementation,
authentication, provider call, route, persistence, webhook or effect, so every
GitHub capability remains `roadmap`.

`S7.B5` implements the first real, read-only GitHub provider adapter behind the
frozen B4 seam. A caller supplies one installation-bound App JWT lease and one
installation-token lease; the adapter never owns a private key, generates a
JWT, mints or persists a token. One bounded observation performs only
`GET /app/installations/{id}` before and after up to five exact
`GET /installation/repositories` pages, with seven calls maximum, fixed
GitHub REST version and origin, streamed response limits, deadlines, closed
errors and no retry. The metadata fence and page-total checks detect observed
drift but cannot make GitHub REST pagination transactional; “current” means a
bounded best-effort provider observation, not a linearizable snapshot.
Loopback tests prove the complete production HTTP path. The opt-in live gate
skips honestly when no configured GitHub App leases are supplied, so the
product capability and every write effect remain `roadmap` until a redacted
real-provider acceptance passes. GitHub remains optional at platform level and
required only for a project that selects the GitHub work motor.

`S7.B6` adds a dark, schema-free anti-corruption projection from the frozen B1
Issue/PR evidence and lineage vocabulary into provider-independent work-graph
identity. It never imports or synchronizes a WorkItem. An open, untracked Issue
may emit only a title-less `proposal_only_no_import` identity anchored by
`repositoryId`, with constant `task`/`backlog` suggestions; a tracked or closed
Issue emits no proposal. Pull requests are always external `evidence_only`
nodes and retain commit join keys for the later B7 evidence slice. Provider
states never become local workflow states. GitHub lineage is labeled
caller-asserted and unverified, and freshness is only the maximum timestamp in
the supplied bounded observation. There is no provider call, route, UI,
persistence, webhook, credential, runner dependency or effect. The mapping is
fixture-proven but remains `roadmap` as a product capability until a governed
acquisition/import path is separately delivered.

`S7.B7` adds a pure dark projection of the frozen B1 check-run and deployment
status evidence onto B6 pull-request head commits. The only join is exact
lowercase 40-hex evidence SHA (`checkRun.headSha` or `deployment.commitSha`)
equality to the PR `headSha` inside one repository; `mergeSha` is not a join
key. Multiple pull requests may share one head-commit node. A deployment may
retain multiple statuses only while its `environment`, `commitSha` and
`deploymentCreatedAt` identity is unchanged. Any malformed, duplicate,
contradictory, cross-repository, unmatched or over-limit run item rejects the
whole observation. All provider status, conclusion and state values remain
verbatim `observed_only_no_authority` evidence and never become WorkItem
workflow state, delivery success, approval, merge eligibility or deployment
promotion authority. The projection contains no provider call, credential,
route, UI, storage, webhook, retry or effect, so the product capability remains
`roadmap`.

Batches:

- `S7.B1` dark GitHub delivery contracts and canonical parsers. **Complete.**
- `S7.B2` pure GitHub App installation-scope authorization. **Complete.**
- `S7.B3` dark read-only fixture source and exact repository membership.
  **Complete.**
- `S7.B4` dark paginated snapshot transport seam and bounded normalizer.
  **Complete.**
- `S7.B5` real/current GitHub App installation discovery and scoped repository
  access. **Code complete; live provider gate pending.**
- `S7.B6` dark Issue/PR identity projection into the Nexus work graph.
  **Code complete; governed import remains roadmap.**
- `S7.B7` dark check-run and deployment-status evidence on B6 pull-request
  heads. **Code complete; acquisition and durable evidence remain roadmap.**
- Intent-gated PR creation, review request, merge and deployment promotion.
- Effect receipts, webhook reconciliation and rate-limit behavior.

Exit: a governed work item reaches a real PR and deployment record with lineage.

### Sprint 8 — Provider broker and routing

Outcome: agents can use model providers without coupling identity to one vendor.

Batches:

- Provider and model catalog — B1 dark contract delivered; types, projection and
  closed vocabulary only. There is no provider call, route, UI, persistence,
  credential, secret, usage claim, fallback or effect; the product capability
  remains `roadmap`.
- Connection-intent resolution — B2 dark contract; pure resolution of an explicit
  provider/method/engine/model request to a declared catalog candidate only. There
  is still no provider call, OAuth or CLI execution, credential, secret,
  persistence, route, UI, usage claim, fallback or effect; a resolved candidate is
  not connected, authenticated, available, executable, authorized or selected for
  a run; the product capability remains `roadmap`.
- CLI session observation — B3 dark, point-in-time read of the existing
  tenant-scoped S6.B4 engine inventory for one B2-declared CLI candidate. Evidence
  remains `hostReported`; it never means connected, authenticated or usable and
  proves no provider account, quota or execution. There is no probe, process,
  provider call, schema, persistence, route, UI, ledger or runner change; the
  product capability remains `roadmap`.
- CLI session observation route — B4 read-only `POST` transport over the B3 D1
  adapter. Identity and active workspace membership precede all query, media,
  length and body observation; after B5 the exact `{runnerId, intent}` envelope
  is streamed under a 32 KiB cap and the bundled declaration is injected
  server-side. The B3 JSON remains field-whitelisted and 200 binds it to the
  declaration digest in a response header. Cross-tenant absence remains
  indistinguishable, all non-POST methods fail closed and no client, provider
  call, process, schema, persistence, ledger or runner change is added. The
  product capability remains `roadmap`.
- Bundled authoritative provider catalog — B5 validates one Git-backed global
  B1 declaration containing only the Anthropic and OpenAI CLI engines, derives
  a canonical declaration SHA-256 and exposes its projection through a
  membership-gated read-only `GET /api/providers/catalog`. Source success and
  failure are memoized; catalog failure returns 503 with no caller-supplied or
  stale fallback. There is no OAuth/model availability claim, dynamic registry,
  runtime override, UI, provider call, process, schema, migration or catalog
  persistence. The product capability remains `roadmap`.
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
