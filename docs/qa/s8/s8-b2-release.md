# S8.B2 release evidence

## Discover and frame

S8.B1 made provider/model declarations safe to validate but intentionally left
the catalog unused. S8.B2 tests the smallest reversible next hypothesis:
NexusOS can resolve one explicit provider/method/engine/model request to a
declared candidate without connecting to or authorizing anything.

The architecture gate ran read-only in Claude Code with exact model
`claude-fable-5`, session `7ef6257b-ed52-4e2b-b22f-fe09a1ac69cc`. Three
challenge rounds corrected catalog-forgery expectations, made the B1 consumer
gate positive and exact, removed an unnecessary error catch, and split
structural from field-type rejection. Final verdict: `GO`, P0=0 and P1=0.

## Delivered boundary

The input version is `nexusos.connection-intent.v1`, with exactly five fields:

```text
specVersion, providerId, method, cliEngine, modelId
```

The resolver accepts the untrusted declaration, not a forgeable B1 projection.
It validates the complete intent before evaluating the catalog. Its 13
rejection reasons map one-to-one to the ordered validation stages.

A resolved candidate carries:

- `resolutionClaim=declared_candidate_only_no_connection`;
- the B1 `catalogClaim=declared_only_no_connectivity`;
- the B1 method `trust=declared_unverified`;
- a copied provider;
- the exact declared method and CLI engine; and
- `declaredModel`, or null when no model was named.

`resolved` is a lookup result. It is not admission, authorization,
authentication, availability, connectivity, engine/model compatibility or run
selection. Lifecycle is evidence copied from the declaration, not a policy
decision.

There is no provider call, OAuth or CLI execution, credential-specific field,
persistence, route, UI, runner change, usage claim, fallback, health claim or
effect. The product capability remains `roadmap`.

## B1 boundary supersession

The B1 release evidence correctly records that no production consumer imported
B1 at its freeze. B2 keeps that evidence immutable and supersedes only the live
gate:

- B1 self paths are explicit;
- sanctioned consumers are exactly the two B2 production modules;
- both sanctioned paths must exist and positively import B1;
- cardinality is fixed at two; and
- every other production import remains forbidden.

B2 has its own repository gate permitting only its two self paths and proving
that no live production module imports `connection-intent`. B1+B2 therefore
remain a closed DARK subgraph.

## Scope and rollback

The exact seven-path allowlist is:

- new `src/contracts/connection-intent.ts`;
- new `src/domain/providers/connection-intent.ts`;
- new `tests/unit/connection-intent.test.ts`;
- new `docs/adr/S8B2-connection-intent.md`;
- this release evidence;
- only the final consumer-gate block in
  `tests/unit/provider-catalog.test.ts`; and
- one additive Sprint 8 hunk in `docs/PROGRAM-PLAN.md`.

No B1 production module, app, database, migration, route, UI, runner, effect,
package or lockfile changes. The two B2 production modules total 278 raw lines,
below the 400-line batch ceiling. No cross-batch file hash is frozen.

Rollback removes the five new files, restores the B1 consumer-gate block and
removes the plan hunk. No persisted or external state can be stranded.

## Focused acceptance

The focused B1+B2 matrix passes 31/31 and covers:

- exact versions, truth claim and 13 rejection reasons;
- OAuth, both CLI engines and nullable/non-null declared model;
- lifecycle copied verbatim without availability interpretation;
- all rejection reasons and multi-defect precedence;
- distinct version, structural and primitive field-type stages;
- forged projections with exact B1 catalog reasons;
- revoked and throwing proxies, symbols and accessor descriptors;
- proof that rejected getters never execute;
- caller truth-label anti-escalation;
- exact no-fallback behavior;
- deterministic, detached and deeply frozen resolved and rejected output;
- the full 16-provider by 64-model catalog bound;
- case-sensitive model matching and collision-safe cross-provider model keys;
- a static no-network, no-process, no-database and no-credential-processing
  gate;
- a repository-derived proof of exactly the two sanctioned B1 consumers; and
- zero production consumers of the B2 boundary across ESM, dynamic and
  CommonJS forms.

Candidate gates pass: TypeScript, lint, the focused B1+B2 matrix (31/31), the
complete unit suite (392/392), production build and rendered-HTML smoke (2/2).
`git diff --check` and the exact seven-path allowlist are re-verified on the
final batch commit.

## Review status

The implementation follows the final Fable consensus. An independent
post-implementation review remains required before promotion. No live provider
or capability `GO` is claimed.

## Remains roadmap

OAuth, CLI execution/probes, credentials, persistence, agent assignment,
budgets, usage, fallback, health/expiry, lifecycle policy, UI and capability
labels remain separate batches. A future adapter must not treat a resolved B2
candidate as authority or connectivity evidence.
