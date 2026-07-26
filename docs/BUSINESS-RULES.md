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
- Only active workspace humans who are active conversation members can read a
  conversation; non-members receive not-found behavior.
- Observers and members of archived conversations cannot send messages.
- A direct conversation has exactly two members and one canonical member key.
- Direct membership is immutable; rooms and handoffs may change membership.
- Removing or leaving a conversation changes membership status and never
  deletes the historical membership row.
- A room or handoff always retains at least one active owner.
- A pin references an immutable message id and never duplicates message text.
- Message envelopes are append-only and use a gap-resistant, conversation-local
  sequence.
- Message text is an erasable payload outside the envelope. Erasure preserves
  sender, sequence, timestamp and keyed integrity evidence.
- Payload erasure is a governed effect; message deletion is not an erasure
  mechanism.
- Private prompt content is never exposed through presence.
- Human presence is self-declared, expires automatically and is not used for
  time-online analytics.
- Presence keeps one replaceable current lease per principal and no transition
  history. `offline` is derived from server time.
- A stale presence fencing token cannot renew or delete the current lease.
- A client without the current fencing token cannot replace a live lease
  unless it sends an explicit takeover command. Opening another tab alone is
  never consent to take over.
- Presence can name only an active room where the principal is an active
  member. Direct messages and handoffs are never published as location.
- An observer sees a room location only when they are also an active member of
  that room.
- DND is a presentation signal, not an authorization or delivery rule.
- Presence cannot authorize, approve or execute any action.
- Presence session keys and fencing tokens are tab-runtime state and are not
  persisted as reusable credentials.

## ActionIntent

- An external effect requires an approved, unexpired ActionIntent.
- A proposer cannot approve the same intent when separation of duties applies.
- Non-human principals cannot receive human approval capabilities.
- High-risk intents require the configured number of distinct human approvals.
- Parameters are immutable after proposal.
- Execution rejects changed target preconditions.
- Idempotency keys prevent duplicate semantic effects.
- Every effect attempt produces a receipt or an explicit unresolved state.

## Attention

- Attention is a personal projection, not an authority channel.
- Approval-required intents address each active human owner/admin exactly once.
- A proposal that requires approval fails closed when no active human
  owner/admin can receive it.
- Workspace members without accountable approval roles do not receive approval
  items merely because they proposed work.
- Opening an item records only `seen`; it cannot change the intent or mint an
  approval.
- A governance decision resolves every addressee copy in the same transaction.
- Expired items leave the active queue with resolution `expired`; history is
  retained and cannot be hard-deleted.
- Non-decision terminal transitions such as cancellation leave the active queue
  with resolution `superseded`.
- Stale `seen` writes fail compare-and-swap and never overwrite newer state.
- A missing deep-link target disables actions instead of selecting a different
  intent.
- Active lists are cursor-paginated; queue badges use a count-only projection.

## Ledger

- Ledger entries are append-only.
- The previous hash and canonical event determine the next hash.
- Corrections use a superseding entry.
- Missing erasable payloads do not invalidate the event hash.
- Verification distinguishes tampering, deletion under policy and missing
  external anchors.
- Evidence events contain identifiers and immutable hash metadata, never a
  copied payload body or free-text annotation.

## Runs and runners

- A run has at most one current lease fencing token.
- A stale runner cannot complete or append authoritative run state.
- Local credentials remain on the runner unless a provider-specific hosted
  connection explicitly requires otherwise.
- Cancellation is cooperative first and forceful only inside the declared
  sandbox boundary.
- Run logs must redact secrets and private prompt content.

## Artifacts and releases

- Every artifact belongs to exactly one organization, project and work item.
- Only an active workspace member can create or read an artifact.
- The first supported artifact is literal Markdown no larger than 256 KiB.
- Every artifact version has an active producer, server-calculated SHA-256,
  exact UTF-8 byte count and immutable lineage.
- Version numbers are contiguous and appends require the caller's observed
  current version; stale writers fail instead of overwriting newer evidence.
- Artifact identity, metadata and versions are append-only. Content lives behind
  an erasable reference whose immutable hash and size remain auditable.
- Exact live content may reuse one organization-scoped payload reference.
  Reuse must verify hash, UTF-8 byte size and literal body; suspected collisions
  fail closed and content is never deduplicated across organizations.
- Erasure is logical unavailability, not cryptographic shredding. It clears all
  live payload rows for the same organization/hash while preserving immutable
  version metadata and lineage.
- Only an active human owner/admin can inspect erasure impact, propose, approve
  or execute it. A multi-admin requester cannot approve their own proposal.
- A solo-owner exception requires explicit acknowledgement and may commit only
  if the approval transaction proves that no other active human owner/admin is
  eligible at that instant.
- Erasure approval is bound to immutable parameters, the complete affected
  version list and the observed organization-scoped reference count. A changed
  blast radius fails before any payload is cleared.
- A content read recomputes both hash and byte size and fails closed on mismatch
  or unavailable payload.
- Cross-organization artifact identifiers return not-found behavior.
- A decision-basis link names one exact immutable version and may be created
  only by an active owner, admin or member while the intent is open.
- The active decision-basis set freezes after approval. Before then only the
  original attacher or an owner/admin may supersede a link; no evidence row is
  deleted.
- A basis version must be readable when first linked. Later governed erasure
  preserves its id, hash, byte size and lineage while making content
  unavailable.
- Human routes cannot create `outcome` evidence. It is reserved for a
  non-human execution transaction while the intent is executing.
- An artifact review is advisory and applies to one exact immutable version;
  it never advances an artifact, approves an ActionIntent or executes an
  effect.
- Only an active human owner, admin or member can record a review. Verdicts and
  reasons use a closed vocabulary and cannot contain free text.
- Each reviewer has one active opinion per version. A changed opinion preserves
  the prior row as superseded, requires the caller's observed review id and
  appends both state events to the ledger.
- A producer may request changes to their own version. Producer approval is
  permitted only for a sole active owner who explicitly acknowledges the
  exception and remains sole eligible reviewer at commit.
- New reviews require a live payload. Governed erasure preserves existing
  review metadata and ledger proof while blocking a blind new review.
- Cross-artifact supersession is advisory registry navigation from an older
  source artifact to a replacement target; it never erases or hides either
  artifact.
- Only an active human owner/admin may declare or retract it. Reasons are closed
  codes and no permanent free text is accepted.
- A declaration pins the exact heads observed by the user. Both must still be
  heads at commit; the target must be live and verified, while the source may
  already be erased.
- Graph nodes are artifact ids. One active outbound relation is allowed per
  source, many sources may share a target, and active cycles or an unproven
  depth-bound walk are rejected.
- A source and target with the same content hash are not a valid replacement.
- Retraction preserves history and proof. Redeclaration is possible only while
  the target again satisfies the live-head rules.
- Supersession never changes artifact `currentVersion`/`updatedAt`, reviews or
  the evidence set of an existing decision.
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
