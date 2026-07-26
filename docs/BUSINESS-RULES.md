# NexusOS Business Rules

## Identity and tenancy

- Every durable record belongs to an organization.
- A principal is a human, agent, automation, policy or runner.
- Only active human memberships can approve risk-bearing intents.
- Cross-organization reads and writes are denied even when identifiers exist.
- Archived entities remain auditable and cannot start new work.

## Projects and teams

- A project has at least one measurable objective.
- A team belongs to one project but a principal may join multiple teams.
- An agent assignment pins a role, model connection, capability policy, memory
  policy and autonomy level.
- Changing authority or model configuration creates a versioned assignment.
- Project, team, agent and connection updates require the caller's observed
  version; stale writes fail instead of overwriting newer state.
- Archiving is soft and blocked while active dependants would become orphaned.
- Agent creation persists its non-human principal, definition and first team
  assignment atomically.

## Work graph

- NexusOS owns immutable `OBJ-...` and `WI-...` references; an external tracker
  reference is a mapping, never the internal identity.
- Objectives move through an explicit `open -> active -> completed|cancelled`
  lifecycle.
- An objective cannot close while it has work items outside `done|cancelled`.
- Work-item transitions use a closed state matrix with explicit rework,
  unblocking and reopen paths.
- A stale write never overwrites a newer objective or work-item version.
- A project cannot archive while it has active objectives, teams or work items.
- Historical work remains editable when a referenced objective is completed or
  an assignee is disabled; changing either reference revalidates it.
- Local work changes are internal state and do not require an ActionIntent.
  Creating or mutating a GitHub/Jira issue is an external effect and does.

## Model connections

- A model connection records provider, OAuth-or-CLI method, status and
  non-secret discovery metadata.
- OAuth tokens, API keys, terminal credentials and refresh secrets never enter
  the control-plane database.
- Local CLI credentials remain in the runner or user terminal.

## Conversation

- Messages cannot approve, reject or execute an action.
- A conversation can reference an ActionIntent by id.
- DMs, rooms and handoffs use one conversation model.
- Private prompt content is never exposed through presence.
- Human presence is self-declared, expires automatically and is not used for
  time-online analytics.

## ActionIntent

- An external effect requires an approved, unexpired ActionIntent.
- A proposer cannot approve the same intent when separation of duties applies.
- Non-human principals cannot receive human approval capabilities.
- High-risk intents require the configured number of distinct human approvals.
- Parameters are immutable after proposal.
- Execution rejects changed target preconditions.
- Idempotency keys prevent duplicate semantic effects.
- Every effect attempt produces a receipt or an explicit unresolved state.

## Ledger

- Ledger entries are append-only.
- The previous hash and canonical event determine the next hash.
- Corrections use a superseding entry.
- Missing erasable payloads do not invalidate the event hash.
- Verification distinguishes tampering, deletion under policy and missing
  external anchors.

## Runs and runners

- A run has at most one current lease fencing token.
- A stale runner cannot complete or append authoritative run state.
- Local credentials remain on the runner unless a provider-specific hosted
  connection explicitly requires otherwise.
- Cancellation is cooperative first and forceful only inside the declared
  sandbox boundary.
- Run logs must redact secrets and private prompt content.

## Artifacts and releases

- Every artifact version has a producer, content hash and lineage.
- Supersession does not erase previous versions.
- A release identifies commit, source work, authorization and deployment state.
- “Last deployed” is derived from deployment evidence, not a manually edited
  label.

## Automation and loops

- Every automation has an owner, trigger, budget and stop policy.
- Retries are bounded.
- Exhausted or ambiguous runs move to attention rather than loop forever.
- Consequential steps pause for approval.
- A fallback model or engine change is visible as an event.

## Capability honesty

- `real`: backed by a production path and tests.
- `simulated`: deterministic, labeled and unable to claim a real effect.
- `degraded`: works with stated limitations.
- `roadmap`: no working execution path.

The UI and documentation must use the same status.
