# ADR S8.B6 — Truthful provider and CLI UX

- Status: Accepted for B6a1; B6a2 and B6b remain planned
- Date: 2026-07-28
- Sprint: 8, batch 6
- Architecture session: `221911c0-1250-4d3b-b876-b8eb5408e2b3`

## Context

S8.B5 provides a membership-gated, read-only provider catalog with a bundled
source digest. The prototype Providers screen predates that contract and shows
hard-coded accounts, healthy sessions and connected states. Those statements
are not derived from B5 and cannot be treated as product evidence.

A robust client boundary requires exact hostile-input parsing, detached frozen
data, request-race control, copy guards and the visible React states. The first
complete design exceeded the 400-line production ceiling. Removing validation
or hiding lines would weaken the boundary, so B6 is split serially instead.

## Decision

S8.B6 is delivered as three explicit slices:

1. B6a1 adds a dark, pure client view-model with no production consumer.
2. B6a2 will atomically remove the demo Providers implementation and mount a
   read-only catalog view that consumes B6a1.
3. B6b may later add bounded CLI-session observation without changing declared
   catalog facts into connectivity claims.

B6a1 does not touch `app/page.tsx`. The pre-existing prototype demo therefore
remains unchanged until B6a2 removes it in the same commit that mounts the real
catalog view. No intermediate placeholder or mixed real/demo surface is
introduced.

## B6a1 wire and projection boundary

`readProviderCatalogView(unknown)` accepts only the exact B5 response grammar:

```text
nexusos.provider-catalog-view.v1
  sourceRef:
    nexusos.bundled-provider-catalog-source.v1
    nexusos_bundled
    declarationSha256 = 64 lowercase hex
  catalog:
    nexusos.provider-catalog-projection.v1
    declared_only_no_connectivity
    providers <= 16
    methods per provider = 1..2
    models <= 64 per provider
```

Every method must retain `trust: declared_unverified`. OAuth must have a null
CLI engine; CLI must name one existing execution engine. Provider, method and
model identities remain unique and every model binds to a declared provider.

Records and arrays require exact own enumerable data properties. Accessors,
symbols, sparse or augmented arrays, non-plain prototypes, malformed proxies,
extra keys, invalid labels and limit overflow fail closed as `null`. Values are
read once into new objects and the accepted projection is deeply frozen, so
caller mutation cannot change rendered facts later.

The client deliberately duplicates the projection vocabulary and bounds rather
than becoming a fifth production consumer of the B1 declaration module. It
imports only the already-authorized B5 view/source stamps. One deeply frozen
wire manifest exposes every locally duplicated server-facing contract
constant, including regex source and flags. Tests compare that manifest and
exact N/N+1 behavior with the current server contracts, so any vocabulary,
engine, pattern or bound drift requires an explicit, reviewed parser update.
This is an anti-corruption boundary, not an independently evolving catalog
definition.

## Derived client primitives

`cliCandidatesFrom` derives only declared CLI methods and preserves their
`declared_unverified` trust. It does not probe, select or authorize a provider.

`catalogDigestMatches` compares a canonical lowercase digest header with the
source reference. This supports the later observation UI without interpreting
a matching digest as freshness, account validity or connectivity.

`ProviderRequestCoordinator` owns independent `catalog`, `options` and
`observe` lanes. A new request aborts only the previous request in its lane;
epoch checks reject stale completions, and `abortAll` supports StrictMode and
unmount cleanup. The coordinator performs no request itself.

## Truthful copy boundary

The module centralizes Portuguese status and detail copy. Status/chip copy
absolutely rejects positive connection, authentication, usability, health,
account, quota, reauthentication and validity lexemes. Detail copy permits
those lexemes only when an explicit `não`, `nem`, `nunca` or `sem` appears in
the preceding bounded window.

The declared state is:

```text
DECLARADO · NÃO VERIFICADO
Catálogo declarado no código. Nenhuma conectividade, credencial ou
disponibilidade foi verificada.
```

This guard does not prove arbitrary prose correct; it prevents the known
positive claim classes from entering the B6 UI contracts unnoticed.

## Effects, consumers and dependencies

B6a1 has zero production consumers. It adds no fetch, route, UI, timer, provider
or CLI call, OAuth flow, process, credential, secret, persistence, schema,
migration, ledger event, runner change, external registry or paid dependency.
GitHub and Jira are not required for runtime behavior.

The only production import is the pure B5 source contract, used for its
view/source stamps. Projection and engine vocabulary is local and deliberately
pinned as described above. The production file remains below 400 raw lines. A
repository-wide test scans the application, source, runner, worker and scripts
roots, tolerates absent roots, freezes the zero-consumer boundary and confirms
that the original demo remains untouched for the later atomic B6a2 replacement.

## Consequences

B6a1 creates a tested anti-corruption layer between untrusted HTTP JSON and
future provider UI. It has standalone value as the reusable parsing, lineage,
copy and request-race contract for B6a2/B6b, while truthfully leaving all visible
provider capability labels unchanged.

The visible false demo is known debt, not B6a1 output. B6a2 must be promoted
serially after B6a1 and must remove that demo atomically; it cannot add a second
surface alongside it.

## Rollback

Rollback removes the view-model, its unit test, this ADR and B6a1 release
evidence, then restores the single Sprint 8 plan hunk. There is no database,
browser, process or external state to strand.

## Remains roadmap

- B6a2 read-only `GET /api/providers/catalog` screen and demo removal;
- B6b CLI-session observation UI;
- OAuth connection establishment and provider execution;
- provider account, quota, health and availability verification;
- encrypted credential references and per-agent assignment;
- budgets, usage, fallback and semantic-degradation events; and
- promotion of the provider capability beyond `roadmap`.
