# ADR S8.B4 — Read-only CLI session observation route

- Status: Accepted
- Date: 2026-07-28
- Sprint: 8, batch 4
- Architecture session: `faa6b5e3-468d-4688-b4f2-c2f306cd0e2a`

## Context

S8.B3 established a dark, tenant-scoped observation boundary that combines one
explicit B2 CLI candidate with the existing S6.B4 engine inventory. It exposes
no transport, so a product client cannot yet request that bounded observation.

The next reversible slice needs a route without widening the B3 truth claim.
It must not probe a CLI, contact a model provider, infer an account or make a
reported session executable. Because the request may contain the maximum valid
provider catalog, the route also needs a transport limit above the worst valid
semantic envelope while remaining bounded against resource exhaustion.

## Decision

S8.B4 exposes exactly:

```text
POST /api/providers/cli-session-observation
```

The route is read-only. It delegates the accepted envelope to
`resolveCliSessionObservationFromD1(identity, envelope)` and returns the
existing B3 resolution union. The response is rebuilt field by field; no
adapter or domain object is spread into the HTTP response.

The untrusted JSON envelope has exactly:

```text
{ runnerId, intent, declaration }
```

No query string is accepted. The route consumes the B3 D1 adapter directly and
there is deliberately no client or UI consumer in this batch.

## Authorization and request-observation order

The route resolves trusted `RequestIdentity` and calls
`requireWorkspaceMember(identity)` before inspecting the URL query, media type,
declared body length or body stream. This order prevents unauthenticated or
non-member callers from using parser differences, size handling or request
timing as a workspace oracle.

The B3 adapter still applies its own server-side inventory membership boundary.
The route does not accept organization or principal identity in its body.

Local `vinext dev` currently injects `NEXUS_ALLOW_LOCAL_IDENTITY=1` from the
pre-existing Vite configuration. That development fallback is not evidence of
production authentication behavior, and an attempted process-level `0`
override is ineffective. The integration gate therefore proves 401 and
authentication-before-body dynamically in a temporary direct Worker that
imports the real `POST` handler with local identity disabled. A source-order
gate independently freezes the same precedence. Fixing the inherited
development override is tracked debt and is outside this route-only batch.

## HTTP contract

All route-handler responses have:

```text
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
Vary: Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization
```

No response emits `Access-Control-Allow-Origin`. The closed status/body grammar
is:

```text
200  existing B3 observed/not_observed union
400  {"error":"invalid_cli_session_observation_request"}
401  {"error":"authentication_required"}
403  {"error":"workspace_membership_required"}
405  {"error":"method_not_allowed"} and Allow: POST
413  {"error":"cli_session_observation_request_too_large"}
415  {"error":"unsupported_media_type"}
500  {"error":"cli_session_observation_failed"}
```

`GET`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` and `HEAD` are explicit 405
handlers. `HEAD` has no response body.

Methods that the App Router does not dispatch to this route, such as extension
verbs, remain framework/ingress behavior and are not claimed by this route
grammar. They cannot invoke the observation handler; future normalization
belongs at ingress or middleware.

The exact route-local `Vary` value is the four fields above. Vinext development
responses may append RSC negotiation fields after those leading fields. That
superset narrows cache reuse; it does not broaden it, and `private, no-store`
remains authoritative. The integration gate checks the exact value around the
real handler in the direct Worker and checks that the same four fields lead the
framework-decorated response.

## Bounded body and media contract

The maximum request body is exactly 4,194,304 bytes. `Content-Length` may be
absent. When present it must be a canonical non-negative decimal integer:
malformed or actual-length-mismatched values return 400, while a declared or
actual length above the cap returns 413.

The body is consumed incrementally. If the actual stream crosses the cap, the
reader is cancelled before the route returns 413. A stream failure fails
closed as 400, and the reader lock is always released.

The accepted media type is `application/json`, optionally with
`charset=utf-8`. Additional parameters and other media types return 415. JSON
decoding uses fatal UTF-8 and rejects a UTF-8 BOM. Empty, malformed and
non-record values, and top-level keys other than the exact envelope, return
400.

The largest valid B1 declaration and B2 intent serialize below the 4 MiB cap;
this is frozen by a focused unit test. Therefore the transport limit does not
reject any currently valid semantic request.

## Privacy and truth boundary

The route adds no logs and reflects no request, exception, organization,
runner name, provider account, credential or raw inventory. It preserves the
B3 distinction between `observed` host-reported evidence and provider
connectivity. An observed response still does not mean connected,
authenticated, usable, selected, authorized for a run, or guaranteed fresh in
the future.

Cross-tenant, absent and inventory-truncated runner targets remain the same
`runner_not_observed` result from B3. The route therefore introduces no runner
enumeration signal.

## Effects and dependencies

S8.B4 adds no provider network call, OAuth flow, CLI process, execution,
filesystem effect, schema, migration, persistence, ledger event, runner
protocol or `model_connections` access. It requires only the existing NexusOS
identity, workspace membership and D1 inventory boundaries. Jira and all paid
external services remain optional and absent.

## Consequences

NexusOS gains one narrow public read seam for future provider-connection UX
without promoting the provider capability beyond `roadmap`. A later client can
consume this contract only in a separately reviewed batch.

The 4 MiB transport allocation is intentionally larger than typical requests
because the existing catalog contract permits 16 providers and 1,024 models.
Streaming enforcement bounds memory and prevents trusting `Content-Length`.

## Rollback

Rollback removes the three S8.B4-created implementation/test files and the two
S8.B4 documents, restores the B3 consumer gate and Sprint 8 plan hunk, and
removes `tests/cli-session-observation-api.integration.mjs` from
`test:integration` in `package.json`. No database or external state can be
stranded. The integration-only direct Worker and its Wrangler configuration
are created under one temporary directory and removed in `finally`; they leave
no shared configuration or state residue.

## Remains roadmap

- client and UI consumption;
- CLI process execution and reprobes;
- OAuth connection and execution;
- provider account, quota and health verification;
- credentials and encrypted references;
- agent assignment, budgets, usage and fallback;
- durable connection state and governance evidence; and
- any promotion of the provider capability label.
