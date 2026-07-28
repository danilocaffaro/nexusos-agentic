# ADR S8.B5 — Bundled authoritative provider catalog

- Status: Accepted
- Date: 2026-07-28
- Sprint: 8, batch 5
- Architecture session: `e30c62c4-e3df-4818-880d-a6b8afaf8d6d`

## Context

S8.B1 defined the provider-catalog declaration and projection, but no
authoritative declaration source. S8.B4 consequently accepted an entire
catalog declaration from the caller on every CLI-session observation request.
That made the client choose the universe against which its own connection
intent was resolved.

NexusOS needs one small, auditable source of truth before adding provider
connectivity. The source must work without Jira, a paid registry, a provider
account, D1 catalog state, or any other external dependency. It also must not
claim that a declared provider is connected, authenticated, usable or
executable.

## Decision

S8.B5 introduces one process-global, Git-backed bundled catalog. Its initial
declaration contains exactly:

```text
anthropic / cli / claude_code_cli / models []
openai    / cli / codex_cli       / models []
```

OAuth entries and model entries remain absent until separately implemented
adapters can support their truth claims. The only catalog truth stamp remains
the existing B1 value `declared_only_no_connectivity`.

The source contract is:

```ts
type BundledProviderCatalogSourceRef = {
  specVersion: "nexusos.bundled-provider-catalog-source.v1";
  source: "nexusos_bundled";
  declarationSha256: string;
};

type ProviderCatalogView = {
  specVersion: "nexusos.provider-catalog-view.v1";
  sourceRef: BundledProviderCatalogSourceRef;
  catalog: ProviderCatalogProjection;
};

type BundledProviderCatalogSnapshot = {
  sourceRef: BundledProviderCatalogSourceRef;
  declaration: unknown;
  projection: ProviderCatalogProjection;
};
```

`getBundledProviderCatalog()` evaluates the literal through the existing B1
contract, reconstructs the canonical B1 declaration in projection order,
serializes that declaration with the shared canonical JSON function and hashes
those bytes with SHA-256. The digest therefore identifies the authoritative
input declaration, not the enriched B1 projection. The resulting declaration,
projection and source reference are deeply frozen.

The process memoizes one promise, including rejection. A source load,
validation or hashing failure therefore remains a stable fail-closed result
instead of being retried implicitly. The exported source factory permits
deterministic success and failure testing without an environment override,
mutable singleton reset or runtime configuration seam.

## Read API

S8.B5 exposes:

```text
GET /api/providers/catalog
```

Trusted identity and active workspace membership are resolved before query or
body inspection. A query string or body is invalid. The 200 response contains
only the projection and source reference; the raw declaration is never
returned.

The closed route grammar is:

```text
200  ProviderCatalogView
400  {"error":"invalid_provider_catalog_request"}
401  {"error":"authentication_required"}
403  {"error":"workspace_membership_required"}
405  {"error":"method_not_allowed"} and Allow: GET
503  {"error":"provider_catalog_unavailable"}
```

`POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` and `HEAD` are explicit 405
handlers. `HEAD` is bodyless. Every route response has:

```text
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
Vary: Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization
```

No response emits permissive CORS or logs catalog/request data. Source failure
returns 503 with no client declaration, stale value or alternative fallback.

The pre-existing Vite configuration forces local development identity. Network
integration therefore does not treat a process-level override as production
authentication evidence. A temporary direct Worker imports the real handler
with local identity disabled and proves 401, authorization precedence, source
failure and the exact route-local `Vary`. Vinext may append RSC negotiation
fields after the frozen four-field prefix on development responses; that only
narrows cache reuse while `private, no-store` remains authoritative.

## CLI observation authority

The S8.B4 request changes from:

```text
{ runnerId, intent, declaration }
```

to exactly:

```text
{ runnerId, intent }
```

The route loads the same bundled snapshot and injects
`snapshot.declaration` into the unchanged S8.B3 adapter boundary. The previous
client declaration and every extra key are invalid. The streaming cap is
reduced from 4 MiB to exactly 32 KiB, which remains above the worst valid B2
intent envelope now that a catalog cannot cross the transport boundary.

On 200 only, `X-Nexus-Provider-Catalog-Digest` contains the same declaration
digest returned by `GET /api/providers/catalog`. The B3 JSON response remains
unchanged and contains no catalog reference. If the source is unavailable,
S8.B4 returns `503 {"error":"provider_catalog_unavailable"}` and does not call
the adapter or accept caller authority.

## Consumer and dependency boundary

The B1 contract has exactly four direct production consumers: the B2 contract
and domain, plus the B5 source contract and domain. The bundled source has
exactly two direct production consumers: the catalog GET route and the S8.B4
route. The S8.B3 D1 adapter remains consumed only by S8.B4. No UI or client
imports any of these server boundaries.

The source is part of the NexusOS codebase and release artifact. Changing it
uses the normal pull-request, B1-validation, digest, CI and deployment
lifecycle. Rollback is a Git revert. There is no runtime environment override,
provider call, CLI process, OAuth flow, schema, migration, catalog table,
catalog D1 read/write, external registry or paid-service dependency.

## Consequences

Catalog authority is now server-owned, deterministic and content-addressed.
Future UIs can discover declared connection methods without being trusted to
define them, and observations can be bound to the declaration used for
resolution.

This is deliberately less dynamic than a database registry. Adding or removing
a provider requires reviewed code and deployment, which is the safer reversible
boundary until tenant-specific connection policy exists.

## Rollback

Rollback removes the three new source/API implementation files and both S8.B5
documents, then restores the S8.B4 route, its unit and integration tests, the
B1 catalog unit test and the single Sprint 8 plan hunk. No database or external
state can be stranded. Integration-only Worker/configuration files are created
under a temporary directory and removed in `finally`.

## Remains roadmap

- OAuth and CLI connection establishment;
- provider and model execution;
- provider account, quota, health and availability checks;
- tenant-specific catalog policy or overrides;
- encrypted credential references;
- per-agent connection assignment, budgets and usage;
- fallback and semantic-degradation events;
- client/UI consumption; and
- promotion of the provider capability beyond `roadmap`.
