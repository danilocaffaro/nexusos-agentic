# S8.B5 release evidence

## Discover and frame

S8.B5 tests one reversible hypothesis: NexusOS can own one dependency-free,
content-addressed provider declaration and use it consistently for catalog
discovery and CLI-session observation without claiming provider connectivity.

The architecture gate ran in Claude Code with exact model `claude-fable-5`,
session `e30c62c4-e3df-4818-880d-a6b8afaf8d6d`. Its final verdict was `GO`,
P0=0 and P1=0. The mandatory implementation base is
`main@3f3cfdc2e86ed83a64ce934fe3351e13be2ff6d5`, tree
`eeacb8c7de1b15091c6b359a7689fad618af7b44`.

## Delivered boundary

The bundled declaration contains only Anthropic via `claude_code_cli` and
OpenAI via `codex_cli`, both with empty model lists. It is validated by B1,
canonically reconstructed, SHA-256 identified, deeply frozen and memoized for
both success and failure. There is no runtime override or singleton reset.

The read-only `GET /api/providers/catalog` returns a projection-only
`nexusos.provider-catalog-view.v1` after identity and membership. It rejects a
query/body, fails closed with 503 when the source is unavailable and never
returns the raw declaration.

S8.B4 now accepts exactly `{runnerId, intent}` under a 32 KiB streaming cap.
It injects the bundled declaration into the unchanged B3 adapter. A successful
response retains the exact B3 JSON and adds only
`X-Nexus-Provider-Catalog-Digest`; the former caller-supplied declaration and
all extra keys are rejected.

## Security and protocol evidence

The focused tests freeze:

- B1 validation before publication and digesting of the reconstructed canonical
  declaration rather than the projection;
- exact bundled provider/method/engine content with no OAuth or model claims;
- deep freezing and process-wide promise memoization for success and failure;
- exact direct-consumer sets for B1, the bundled source and B3, with no client;
- identity then membership before request observation on both routes;
- exact private/no-store, nosniff, `Vary`, method and bodyless-HEAD behavior;
- projection-only catalog output and sanitized 400/401/403/405/503 errors;
- exact two-key B4 envelope, 32 KiB cap and server-side declaration injection;
- identical catalog/observation digest headers and unchanged B3 JSON; and
- source failure with no fallback or adapter invocation.

The official API integration program exercises both deployed HTTP boundaries,
real workspace membership and D1 runner inventory. It covers authorization
precedence, tenant anti-enumeration, query/body and method grammar, exact and
over-cap bodies, missing `Content-Length`, removal of caller catalog authority,
digest equality and the observed response.

The pre-existing Vite serve configuration injects
`NEXUS_ALLOW_LOCAL_IDENTITY=1`, so network development behavior is not treated
as a production authentication claim. A temporary direct Worker imports the
real route seams with local identity disabled and proves both 401 paths,
authentication-before-body, exact route-local `Vary` and memoized source
failure across both APIs. Vinext may append RSC negotiation fields after the
four frozen `Vary` leaders on network responses; `private, no-store` remains
authoritative.

## Acceptance results

The final candidate records:

```text
Focused B1-B5 unit: 63/63 PASS
Complete unit: 477/477 PASS
TypeScript: PASS
Lint: ESLint + Oxlint PASS
Official integration programs: 11/11 programs PASS
Production build: PASS, both provider routes in generated route table
Rendered HTML smoke: 2/2 PASS
git diff --check: PASS
Ten-path allowlist: PASS, one PROGRAM-PLAN.md hunk
Claude Opus 5 implementation review: GO, P0=0, P1=0
```

The complete serial `npm test` gate passed TypeScript, unit, runner, migration,
all eleven integration programs, production build and rendered smoke in one
process chain. An earlier aggregate run was intentionally overlapped with a
second standalone integration chain and encountered transient missing fixture
state inside the pre-existing runs integration. The standalone chain passed
11/11 and the clean serial aggregate rerun passed end to end; no concurrent
integration result is used as release evidence.

After the final source-failure classification hardening, the focused 63 tests,
TypeScript, lint, the dedicated provider API integration and
`git diff --check` were rerun and passed. That integration proves a generic
catalog-source rejection becomes 503 without a digest, while the normalizer
wraps only source acquisition and leaves later adapter failures on the
existing 500 boundary.

## Exact scope

The ten-path allowlist is:

- new `src/contracts/provider-catalog-source.ts`;
- new `src/domain/providers/bundled-provider-catalog.ts`;
- new `app/api/providers/catalog/route.ts`;
- new `docs/adr/S8B5-bundled-provider-catalog.md`;
- this release evidence;
- modified `app/api/providers/cli-session-observation/route.ts`;
- modified `tests/unit/cli-session-observation-route.test.ts`;
- modified `tests/cli-session-observation-api.integration.mjs`;
- modified `tests/unit/provider-catalog.test.ts`; and
- one Sprint 8 hunk in `docs/PROGRAM-PLAN.md`.

Dependencies, package scripts and lockfiles are untouched. There is no schema,
migration, UI, client, ledger, runner protocol, process, provider network,
environment override, catalog persistence or `model_connections` change.

## Lifecycle and rollback

Catalog edits follow the normal Git pull-request, B1 validation, canonical
digest, CI and deployment lifecycle. A deployment rollback or Git revert
restores the preceding catalog and digest.

Batch rollback removes the five new files and restores the five modified files.
No database or external state can be stranded. The integration-only direct
Worker and Wrangler configuration live inside the test temporary directory and
are always removed in `finally`; the official integration chain and
`package.json` remain intact.

## Review status

The first independent implementation review ran in Claude Code session
`88f8d802-ab5d-487c-b51a-dc42e706b24f` with exact model
`claude-opus-5`. It found P0=0 and one P1: Prettier had created a second,
cosmetic `PROGRAM-PLAN.md` hunk outside Sprint 8. That hunk was restored
exactly. The same review cycle then confirmed the one-hunk plan delta and
returned technical `GO`, P0=0 and P1=0; a fresh exact-model final review is
recorded after the evidence commit.

The final independent review ran against hardening commit `5aa58b7` in Claude
Code session `ff405ff7-9e0e-42bf-bcac-87e93e53b4f2` with exact model
`claude-opus-5`. It returned `GO`, P0=0, P1=0, no required fixes and confirmed
the ten-path wiring/rollback boundary. Its optional P2 observations do not
change the declared contract or release gate.

No provider connectivity, execution, availability or capability `GO` is
claimed.
