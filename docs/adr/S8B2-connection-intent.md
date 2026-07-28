# ADR S8.B2 — Dark connection-intent resolution

- Status: Accepted
- Date: 2026-07-28
- Sprint: 8, batch 2
- Architecture session: `7ef6257b-ed52-4e2b-b22f-fe09a1ac69cc`

## Context

S8.B1 validates an untrusted provider/model declaration and projects a closed,
truth-stamped catalog. It deliberately has no consumer and cannot answer
whether an explicit provider, method, CLI engine and optional model named by a
caller exist together in that declaration.

The next roadmap bullet proposes OAuth and CLI adapters. Implementing either
now would introduce I/O, authentication, process execution and capability
claims before NexusOS has a pure boundary against ambiguous requests and
semantic fallback.

## Decision

S8.B2 adds a pure resolver for an explicit connection intent. It accepts:

```text
{ specVersion, providerId, method, cliEngine, modelId }
```

The resolver accepts only an untrusted B1 declaration as its second argument.
It never accepts a B1 projection because a caller can forge that structure and
its truth labels. The resolver invokes `evaluateProviderCatalog` synchronously
inside the same call and resolves only against the resulting projection.

An accepted lookup is labeled:

```text
resolutionClaim=declared_candidate_only_no_connection
catalogClaim=declared_only_no_connectivity
trust=declared_unverified
```

The result status is `resolved`, never admitted or connected. It means only
that the supplied declaration names the exact candidate.

## Option decision

| Option | Decision | Reason |
| --- | --- | --- |
| Pure lookup/index | Rejected | It duplicates B1's small ordered projection and invites stale cache state without adding a request boundary. |
| Explicit connection-intent resolver | Accepted | It is the smallest falsifiable behavior required before any adapter can safely interpret a request. |
| Adapter port without implementation | Rejected | A type-only port has no behavior to verify and introduces premature capability vocabulary. |
| Local CLI probe/adapter | Rejected | It would execute a process and claim runtime availability, outside B2. |

## Contract and rejection machine

The intent version is `nexusos.connection-intent.v1`. The resolution version is
`nexusos.connection-intent-resolution.v1`.

The rejection vocabulary is bijective with a linear validation machine:

1. `intent_not_record`;
2. `intent_structure_invalid`;
3. `intent_spec_version_mismatch`;
4. `intent_field_type_invalid`;
5. `intent_provider_id_invalid`;
6. `intent_method_invalid`;
7. `intent_method_engine_mismatch`;
8. `intent_model_id_invalid`;
9. `catalog_rejected`;
10. `provider_not_declared`;
11. `method_not_declared`;
12. `engine_not_declared`;
13. `model_not_declared`.

Intent validation finishes before catalog evaluation. Structural errors are
distinct from primitive field-type errors, so every reason belongs to exactly
one stage. Catalog rejection includes only the closed B1 `catalogReason`, never
caller text.

There is no fallback, normalization, case-folding, fuzzy lookup or candidate
substitution. A CLI engine mismatch rejects rather than selecting the
provider's declared engine.

## Optional declared model

`modelId=null` means that the caller names only a provider and method. A
non-null value means only that the intent additionally names a model declared
for the provider.

The output field is `declaredModel`, not model selection. B2 performs no
engine-to-model compatibility check because that would claim executable
capability. Lifecycle is copied verbatim, including `retired`, `deprecated`
and `unknown`; resolution is not availability policy.

## Trust and DARK activation

Identifiers and labels remain untrusted user-supplied text. B2 does not log,
persist or render them. A future consumer must make an explicit
data-minimization decision and use context-appropriate escaped text rendering.

B2 activates B1 only inside a closed pure subgraph:

```text
connection-intent contract/domain
  -> provider-catalog contract/domain
  -> execution-engine vocabulary
```

Exactly the two B2 production modules are sanctioned B1 consumers. A positive
and negative repository gate enforces that set. No production module may
consume B2, so the live application has no incoming edge to the subgraph.

The B1 release evidence remains an immutable historical statement: at the B1
freeze there was no production consumer. B2 moves that dark boundary outward
and records the supersession in its own release evidence.

## Threat model

- Plain or null-prototype records with exact own enumerable data properties
  are required.
- Identity-reflection failures reject as `intent_not_record`; key or descriptor
  reflection failures reject as `intent_structure_invalid`.
- Accessor descriptors are rejected without invoking getters.
- Snapshots prevent second reads and caller mutation from changing resolution.
- Hostile unknown inputs are total by construction; unexpected internal
  invariant failures remain fail-loud.
- B1 bounds cap work at 16 providers and 64 models per provider; identifier
  patterns are bounded and linear.
- Caller-supplied truth labels and unknown fields are structural errors.
- The resolver reads no ambient authority and cannot act as a confused deputy.
- Exact matching and the B1 length-prefixed model key prevent ambiguity.

## D1 boundary

A connection intent is not a `model_connections` row and `method` is not proof
of the D1 `authMethod` state. B2 creates no record, identifier, status,
credential reference or migration. Persistence needs a separate contract and
truth model.

## Consequences

Future OAuth and CLI adapters can consume one exact, fail-closed request
resolver instead of inventing provider-specific lookup and fallback behavior.
B2 itself cannot connect, authenticate, authorize or execute anything.

## Rollback

Rollback removes the five additive B2 files, restores the final B1 consumer
gate and removes the single Sprint 8 plan hunk. No data, credential, lease,
process or external record can be stranded.

## Remains roadmap

- OAuth execution and local CLI execution/probes;
- credential references and encryption;
- persistence and per-agent assignment;
- budgets, usage accounting and fallback;
- health, expiry and reconnection;
- lifecycle policy, UI and capability-label promotion;
- accepting provenance-verifiable projections as input; and
- any relaxation of the B1 Unicode-format-character rule.
