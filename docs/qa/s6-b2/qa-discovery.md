# S6.B2 QA discovery

## Product truth

This batch proves fenced coordination and crash-safe delivery for one fixed
diagnostic outcome. It does not execute user work, supervise a process, stream
runner output or attest/sandbox the host.

## Principal risks

- two runners receive live authority for the same run;
- a stale fence completes after reassignment;
- nonce replay is mistaken for durable semantic idempotency;
- an effect commits without its operation record or vice versa;
- a lost response after the signature window duplicates a completion;
- operation cleanup removes the evidence needed to reject an old retry;
- a revoked runner obtains a cached success;
- a crash before durable persistence fabricates a recovered outcome;
- a corrupt outbox file blocks every healthy operation;
- two runner processes use one private identity concurrently;
- late completion and deadline rules create two competing authorities;
- UI labels the closed diagnostic as arbitrary execution.

## Frozen test oracles

- one run has one current fence and every authoritative mutation matches it;
- reassignment increments the fence and kills every older completion;
- expiry alone permits reassignment but does not supersede the current fence;
- nonce and operation idempotency use distinct tables and retention horizons;
- effect and semantic operation record commit or roll back together;
- the local operation is durable before its first network send;
- a fresh signature after restart reuses the stable operation id and exact
  body bytes;
- compacted operation tombstones reject reapplication for the life of the run;
- revocation is checked before nonce or operation replay;
- execution, sandbox and streaming remain explicitly roadmap.
