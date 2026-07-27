# S6.B4 architecture consensus

## Decision

The S6.B4 architecture is accepted for B4.1. NexusOS will orchestrate local
Claude Code and Codex CLI processes through an open `ExecutionEngine` port. It
will not embed either CLI as the platform kernel. Engine execution is optional
for NexusOS and assigned-only for an engine run.

## Independent review sequence

1. Fable defined the adapter/port boundary and recommended reuse behind a
   vendor-neutral contract.
2. The first Opus 5 review failed with P0=3/P1=8. The design removed prompt
   plaintext from durable replay, replaced a filesystem key assumption with a
   Worker binding keyring and proved the 4096-byte completion envelope.
3. The second Fable review returned an architecture pass with P0=0 and two
   pre-implementation P1 hardenings. The design added a lease-pinned version
   re-probe and a complete 0600 scratch lifecycle.
4. The first Opus delta failed with P0=0/P1=3. The design added bidirectional
   diagnostic/engine route guards, a valid recoverable/prunable outbox-v3
   acknowledged variant and a realizable audited deadline terminal path.
5. The final Opus 5 delta passed with P0=0/P1=0. It independently rechecked
   all prior P0/P1 findings against the live B3 schema, route, repository and
   runner substrate.

The six final P2 recommendations were absorbed before implementation: a
storage-validated `run.expired` ledger proof, immutable pinned engine admission
on renew, immutable expired state, storage-exact engine admission shapes, an
operation-bound engine receipt discriminator and the production cron location
and sweep bounds.

## Tool evidence

- Claude Code CLI `2.1.219`, model Fable for architecture and Opus 5 for gates.
- Codex CLI `0.145.0` flags and stable feature vocabulary were checked against
  the installed CLI and current local OpenAI manual.
- Review sessions were read-only and did not edit files or run package
  managers/tests.

## Release rule

B4.1 may start. B4.2–B4.5 remain gated by their batch-specific tests. One-shot
CLI execution stays `roadmap` until B4.5 passes full regression, real local
acceptance, browser truth checks and a final Opus review with P0=0/P1=0.
