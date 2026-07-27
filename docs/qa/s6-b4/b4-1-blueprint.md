# S6.B4.1 dark contract blueprint

> Status: complete — Opus final PASS P0=0/P1=0/P2=0
> Scope: contracts and pure ports only

## Outcome

The repository has one vendor-neutral vocabulary for one-shot CLI work and a
fake `ExecutionEngine`, while every runtime route, database schema, runner
probe and UI label remains unchanged.

## Planned files

- `src/contracts/execution-engines.ts`
- `src/domain/runners/execution-engine.ts`
- `tests/unit/execution-engine.test.ts`
- frozen diagnostic assertion in the dedicated B4.1 test, alongside unchanged
  existing lease tests

## Contract slice

- closed engine names;
- prompt-free job descriptor with lease-pinned engine version;
- additive closed signature domains for engine report, claim, prompt read and
  completion;
- engine probe/readiness facts;
- bounded execution input/result and base64url receipt;
- pure parser/validator with exact keys, decoded-byte bounds and a maximal
  canonical body proof under 4096 bytes;
- fake engine implementing the same async/cancel contract.

## Invariants

1. No prompt field or control-plane copy appears in a job descriptor or
   receipt; provider excerpts may echo it and remain sensitive payload.
2. No configured executable path, provider credential or arbitrary argv
   crosses the port; the adapter receives only its fresh workdir.
3. Output bounds are constants and timeout is a server-pinned 270000–600000ms
   clamp, never a caller option.
4. Adapter failures become closed values; programmer/contract failures remain
   fail-loud.
5. Diagnostic public bytes and route behavior do not change.
6. No code in B4.1 imports child-process APIs or spawns a command.
7. Execution, Sandbox and Streaming stay `roadmap`.
8. Maximal receipt JSON, including every escape-insensitive bound, fits the
   frozen signed transport.
9. The later creation transport reserves 56 KiB so worst-valid JSON escaping
   cannot make a valid 8192-byte prompt unreachable.
10. Diagnostic route bytes stay frozen and engine operations use separate
    domain/path contracts.
11. Probe facts have one closed runtime parser and the fake retains no prompt
    or workdir.
12. Summary is a closed adapter token; only encrypted excerpts can carry
    provider text.

## Gate

- typecheck, lint and all unit tests;
- dedicated contract boundary/fuzz matrix;
- frozen diagnostic claim/completion bytes;
- static no-route/no-schema/no-spawn diff inspection;
- Opus design review of the ADR and implementation review of B4.1 with zero
  P0/P1.

## Rollback

B4.1 is dark and schema-free. Reverting its contract/port/test commit removes
the entire slice without data migration or runtime compatibility work.
