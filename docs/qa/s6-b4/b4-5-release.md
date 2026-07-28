# S6.B4.5 release evidence

## Outcome

B4.5 completes the first truthful NexusOS product loop for explicitly assigned
one-shot CLI analysis. A workspace owner can inspect server-projected
runner/engine eligibility, create exactly one encrypted run, follow its stored
lifecycle and immutable receipt, and explicitly read a governed provider
excerpt as opaque Base64URL.

Only assigned one-shot Claude Code CLI and Codex CLI execution is labelled
`REAL`. General tools, workspace mutation, ambient work discovery, streaming
provider output and OS-level provider isolation remain `ROADMAP`.

## Product and authority boundary

The browser receives a closed, bounded option projection from the server. A
runner name, reported engine version and freshness are evidence for selection;
they are not a reservation or a promise that a later claim will succeed. The
create request contains one canonical caller-generated `Idempotency-Key` and
one explicit runner/engine assignment. There is no client retry, engine
fallback or pool selection.

The server binds the creation proof to workspace, requester and request
fingerprint. An ambiguous transport result becomes `outcome_unknown`; the
browser may only reconcile the same key. A created proof is durable. A
confirmed-not-created proof has bounded retention and is the only state that
releases the client latch for a new explicit submission.

The read model preserves stored lifecycle status separately from server-derived
overdue presentation. Detail and latest event are tenant-scoped, prompt-free
and bounded. Receipt metadata is immutable. Protected excerpt access is a
separate owner-only action whose closed states are:

- `absent`: neither receipt nor protected payload exists;
- `erased`: immutable receipt pins remain but protected bytes were removed; and
- `stored`: stdout/stderr bytes are returned only as bounded opaque Base64URL.

The client never decodes or interprets those bytes, and the polite status
channel never announces the payload, digest or erasure timestamp.

## Registry convergence

The first page is periodically refreshed to discover work created by another
client or runner. Additional pages remain attached only when the complete
first-page membership and its boundary cursor are unchanged. Otherwise the
client resets to the new authoritative cursor and announces that additional
pages may be loaded again.

A selected run continues detail polling even when it is no longer present in
the refreshed first page. Append collisions do not become dead clicks, stale
responses cannot announce state, and successful preserved refreshes clear
transient feedback. The run list and selected-detail region have stable
accessible names and expose their busy state.

## Independent architecture and review

Fable architecture session `441072fd-ea9a-4423-8162-b536abaf6eb4` defined
the product/controller split, strict authority projections and ambiguous
creation state machine. The backend Opus session
`67973c8d-c385-4d4b-8933-0b74a85bbc7e` reviewed the storage, route and
retention implementation.

Final Opus session `c47c7e41-8c3a-48dd-9028-719fdeedfcd1` found one release
P1: the options and protected-excerpt API programs existed and passed
individually but were not included in the official `test:integration` command.
The command now runs all nine programs, CI invokes that exact command and a
unit guard fails if either suite is removed. The review's two residual P2
observations were also absorbed: transient refresh feedback now clears and the
detail busy region has an accessible name. The final delta returned `GO` with
zero P0 and zero P1.

## Parallel integration guard

B4.5 was composed in isolated feature worktrees and checked by an independent
integration lane before promotion. The guard compared direct and reverse
composition tree hashes, then tested the combined tree. That lane discovered
three defects before release: invalid old-cursor continuation, loss of
externally created runs when no local run was active and polling loss for a
selected run outside the refreshed first page.

Build caches are isolated per worktree. CPU- and timing-sensitive runner suites
use a global mutex: an earlier concurrent run produced a timing-only failure,
while the authoritative serial rerun passed. This is a delivery-control
requirement for subsequent parallel sprints, not a product exception.

## Browser evidence

The final product was exercised through the running application, not a static
render:

- desktop `1440x900`: document width equals viewport width;
- mobile `390x844`: document width equals viewport width;
- the one-shot panel, named run list, named detail region and polite status
  channels are present at both breakpoints;
- keyboard focus remains visible; and
- the browser console contains zero warnings or errors.

## Automated release gate

The final candidate passed:

- unit suite: 361/361;
- runner suite: 477/477;
- migration and preflight suite: 39/39;
- all nine API integration programs, including options authorization/tenancy/
  overlays/caps and protected-excerpt authorization/tenancy/state/crypto
  failure;
- TypeScript;
- ESLint and Oxlint;
- production build;
- rendered smoke: 2/2;
- `git diff --check`;
- production dependency audit: zero vulnerabilities;
- B2a rollback: `GO`;
- B2b rollback: `GO`; and
- Drizzle schema drift: zero.

## Rollback and dependency posture

The product controller, read routes and create/reconcile routes are additive to
the already released engine runtime. Rolling back the product surface does not
invent or cancel server truth; active local operator sessions and persisted
runs retain their existing lifecycle. Schema and journal compatibility remain
covered by the B2a/B2b rollback gates.

NexusOS does not require Jira, Slack or another paid work system for this
capability. Provider authentication remains the operator's local OAuth/CLI
session. GitHub Free may be the default delivery motor in Sprint 7, while
external systems remain optional connectors behind ports.

## Handoff

Sprint 8 may compose provider identity and connection intent over the same
vendor-neutral boundary. It must not persist credentials, claim an OAuth/CLI
connection before authoritative verification or widen an agent's authority
from a provider declaration alone.
