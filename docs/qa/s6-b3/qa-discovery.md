# S6.B3 QA discovery

## Product truth

This batch proves an append-only signed history of host assertions and a
server-owned routing decision. It does not prove the host is truthful, activate
an OS sandbox or execute user work.

## Principal risks

- host self-report is mislabeled as verification or enforcement;
- nonce replay is mistaken for durable report idempotency;
- an outbox schema upgrade quarantines a pending B2 completion;
- a probe command or argument is influenced by server input;
- a one-lease-per-runner index deadlocks after cross-run expiry;
- migration silently ends legacy leases without operational history;
- revoke reports success while a lease remains active;
- report rows or evidence can be rewritten or deleted;
- a run assigned to one runner is claimed by another;
- claim and revocation races exhaust retries instead of being classified;
- stale or unknown declarations are admitted;
- capability detail leaks paths, usernames, credentials or environment;
- periodic reports contend on the organization Decision Ledger;
- GET records derived expiry or otherwise mutates storage;
- CI omits the crash-safe runner tests.

## Frozen test oracles

- every user-facing declaration is explicitly unverified and host-reported;
- Sandbox, Execution and Streaming remain roadmap;
- semantic report id prevents reapplication beyond the nonce window;
- active-state validation precedes replay;
- version-1 outbox entries remain deliverable after a version-2 upgrade;
- all probes are local static allowlists with no network-controlled argv;
- report semantics and evidence items are append-only;
- latest and expiry are derived from server receive time without GET writes;
- one runner has at most one active lease and one run has at most one active
  lease;
- a new claim atomically reconciles the same runner's expired lease in any
  previous run;
- revocation is one bounded batch and success implies zero active leases;
- assigned/admission guards exist in repository and storage;
- unassigned B2 diagnostic behavior remains unchanged.
