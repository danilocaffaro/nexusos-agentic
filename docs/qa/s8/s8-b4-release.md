# S8.B4 release evidence

## Discover and frame

S8.B4 tests one reversible hypothesis: NexusOS can expose the existing S8.B3
CLI session observation through a bounded, tenant-safe read route without
adding provider connectivity, execution or persistence.

The architecture gate ran in Claude Code with exact model `claude-fable-5`,
session `faa6b5e3-468d-4688-b4f2-c2f306cd0e2a`. The final verdict was `GO`,
P0=0 and P1=0. The mandatory implementation base is
`main@5c1e478ae18a24418e40eadd717ba22f430f0097`, tree
`ba4843d0c2daddbe7e6460d88d50141f0cd69567`.

## Delivered boundary

The only production change is the read-only route:

```text
POST /api/providers/cli-session-observation
```

Trusted identity and active workspace membership are established before query,
media, declared length or body observation. The accepted body is a fatal-UTF-8,
BOM-free JSON record with exactly `runnerId`, `intent` and `declaration`.
`application/json` optionally accepts `charset=utf-8`.

The streaming body cap is 4,194,304 bytes. Missing `Content-Length` is valid;
malformed or mismatched length is 400; declared or actual overflow is 413; and
the stream reader is cancelled on actual overflow. A focused construction
proves the largest valid semantic B1/B2 envelope remains below the cap.

The 200 response is rebuilt field by field from the existing B3 union. It
retains the exact `hostReported` and `declared_unverified` disclosures and
cannot expose extra adapter fields.

## Security and protocol evidence

The focused route tests freeze:

- identity then membership before any untrusted request observation;
- exact private/no-store, nosniff and four-field `Vary` policy;
- no permissive CORS header and no logging;
- the closed 200/400/401/403/405/413/415/500 grammar;
- explicit GET, PUT, PATCH, DELETE, OPTIONS and bodyless HEAD rejection with
  `Allow: POST`;
- streaming enforcement, overflow cancellation, length matching, fatal UTF-8
  and BOM rejection;
- the exact top-level envelope and field-by-field response projection;
- one production consumer of the D1 adapter, exactly the route, with no client;
  and
- a worst valid semantic request below the route cap.

The official route integration program exercises the deployed HTTP boundary,
real identity/membership and D1 inventory. It covers authorization precedence,
media and byte failure modes, explicit methods, exact response headers, a fresh
observed target, and cross-tenant anti-enumeration.

The pre-existing Vite serve configuration injects
`NEXUS_ALLOW_LOCAL_IDENTITY=1`, so a process-level `0` does not produce a 401
through `vinext dev`. The test does not treat that development fallback as a
production authentication claim. It starts a temporary direct Worker with
local identity disabled, imports the real `POST` handler, and dynamically
proves 401 plus authentication-before-body. A static source-order gate freezes
the same precedence. The ineffective development override remains explicit
technical debt outside this allowlist.

The route-local `Vary` value is exactly the four frozen identity fields. Vinext
may append RSC negotiation fields to network responses after those four
leaders; this is a cache-narrowing superset, while `private, no-store` remains
authoritative. The direct Worker verifies the exact route value and the Vinext
test verifies the leading four fields.

## Acceptance results

Final gate results are recorded on the candidate commit:

```text
Focused S8.B3+B4 unit: 23/23 PASS
Complete unit: 415/415 PASS
TypeScript: PASS
Lint: ESLint + Oxlint PASS
Official integration programs: 11/11 programs PASS
Production build: PASS, route present in generated route table
Rendered HTML smoke: 2/2 PASS
git diff --check: PASS
Eight-path allowlist: PASS
```

The official integration chain now contains eleven programs; the S8.B4 program
is appended after the S8.B3 adapter program already inherited by CI.

## Exact scope

The eight-path allowlist is:

- new `app/api/providers/cli-session-observation/route.ts`;
- new `tests/unit/cli-session-observation-route.test.ts`;
- new `tests/cli-session-observation-api.integration.mjs`;
- new `docs/adr/S8B4-cli-session-observation-route.md`;
- this release evidence;
- only the B3 consumer gates in
  `tests/unit/cli-session-observation.test.ts`;
- one additive Sprint 8 hunk in `docs/PROGRAM-PLAN.md`; and
- only the `test:integration` script in `package.json`, appending the S8.B4
  program after S8.B3.

Dependencies and lockfiles are untouched. There is no schema, migration, UI,
client, ledger, runner, process, provider network or `model_connections`
change.

## Review status

The implementation follows the final Fable consensus. A second independent
post-implementation Fable review ran in Claude Code session
`31c5793c-6775-4066-bf81-ae58a33fae0f`. It returned technical `GO`, P0=0,
with one P1 limited to filling and committing this acceptance evidence. The
results above and the documentation commit resolve that packaging finding; no
code correction was requested. Opus implementation review remains required
before promotion. No live provider, connectivity, execution or capability
`GO` is claimed.

## Rollback

Rollback removes all five created files, restores the B3 consumer gate and the
single Sprint 8 plan hunk, and removes the S8.B4 program from
`test:integration`. That restores all three modified files, including
`package.json`, so CI cannot reference a removed test. No persisted or external
state can be stranded. The integration-only direct Worker and Wrangler config
live inside the test temporary directory and are always removed in `finally`,
leaving no shared config residue.
