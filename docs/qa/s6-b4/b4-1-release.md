# S6.B4.1 release evidence

## Outcome

B4.1 is complete. NexusOS now has a dark, vendor-neutral one-shot CLI engine
contract without route, schema, UI truth promotion or process execution.

Delivered:

- closed Claude Code/Codex engine, probe, job, result and receipt vocabulary;
- prompt-free serialized job descriptors and server-pinned timeout bounds;
- strict canonical completion parser with per-stream and combined excerpt
  limits;
- a maximal golden body of 2119 bytes under the 4096-byte signed transport;
- additive engine signature domains with frozen diagnostic signing bytes;
- pure `ExecutionEngine` port and a fake that retains no prompt or workdir;
- sanitized fail-loud contract errors and closed operational fault mapping.

Execution, Sandbox and Streaming remain `roadmap`.

## Automated gates

- typecheck: pass;
- unit: 170/170;
- runner: 23/23;
- migrations/preflight: 22/22;
- governance, presence, realtime, artifacts, runners and runs integrations:
  pass;
- production build and rendered smoke: pass;
- ESLint and oxlint: pass;
- production dependency audit: zero vulnerabilities;
- Drizzle schema generation: no schema changes;
- diff hygiene and static no-spawn/no-route checks: pass.

## Independent implementation review

Opus 5 reviewed the implementation and successive hardening deltas. The final
confirmation on the exact commit candidate returned:

- verdict: PASS;
- P0: 0;
- P1: 0;
- P2: 0;
- P3: 3 optional, non-blocking observations.

The final gate explicitly confirmed common validation for returned and
synthesized results, sanitized `EngineContractError`, runtime rejection of
excluded fault reasons, strict success flags and representable cancel/timeout
races.

## Rollback

The batch is schema-free and dark. Reverting its single implementation commit
removes all B4.1 runtime code while leaving the accepted architecture record
and every existing API/storage behavior intact.
