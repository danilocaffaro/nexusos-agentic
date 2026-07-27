# S6.B4.1 dark contract blueprint

> Status: design review required
> Scope: contracts and pure ports only

## Outcome

The repository has one vendor-neutral vocabulary for one-shot CLI work and a
fake `ExecutionEngine`, while every runtime route, database schema, runner
probe and UI label remains unchanged.

## Planned files

- `src/contracts/execution-engines.ts`
- `src/domain/runners/execution-engine.ts`
- `tests/unit/execution-engine.test.ts`
- frozen diagnostic assertions in existing lease tests

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

1. No raw prompt appears in a job descriptor or receipt.
2. No filesystem path, provider credential or arbitrary argv crosses the port.
3. Output bounds and timeout are constants, not caller options.
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
