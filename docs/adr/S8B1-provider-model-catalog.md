# ADR S8.B1 — Dark provider/model catalog

- Status: Accepted
- Date: 2026-07-28
- Sprint: 8, batch 1

## Context

NexusOS needs a provider-neutral vocabulary before it can connect any model
provider. Provider names, model availability and connection methods are not
proof of connectivity. Combining those declarations with provider calls,
credentials, persistence or health state in the first batch would create a
false product claim and make rollback depend on external state.

The existing D1 connection method vocabulary is `oauth | cli`, and the frozen
execution-engine vocabulary is `claude_code_cli | codex_cli`. B1 must align
with those names without changing or integrating either boundary.

## Decision

S8.B1 is a pure DARK declaration-to-projection boundary:

1. accept one exact, versioned declaration containing providers, methods and
   models;
2. reject the whole declaration on any malformed, unknown, duplicate,
   ambiguous or over-limit value;
3. produce a detached, deterministic and deeply frozen projection; and
4. stamp claims owned by NexusOS:
   `catalogClaim=declared_only_no_connectivity` and
   `trust=declared_unverified`.

The vocabulary is closed:

- connection methods: `oauth | cli`;
- CLI engines: the frozen execution-engine names;
- model lifecycle: `available | deprecated | retired | unknown`;
- at most 16 providers and 64 models per provider.

`oauth` requires a null CLI engine. `cli` requires exactly one frozen CLI
engine name. Provider and model IDs follow narrow code-oriented patterns;
display names are bounded to 64 UTF-16 code units. Providers, methods and
models are sorted with locale-independent code-point comparison.

The projector is total for arbitrary unknown input. It accepts only plain or
null-prototype records with exact own enumerable data properties and ordinary
contiguous arrays. Extra, symbol, hidden, inherited, accessor, sparse and
throwing structures fail closed. No partial catalog is emitted.

## Trust boundary

The input is a declaration, not evidence. B1 performs no connectivity check
and carries no provider health, account, usage, budget, credential or generic
metadata field. Caller-supplied truth stamps are invalid shape, so input
cannot promote itself from declared to verified.

There is no provider call, route, UI, persistence, credential, secret, usage
claim, fallback or effect; the product capability remains `roadmap`.

GitHub Free and local NexusOS code may be required by later product decisions,
but Jira, a paid provider and every external provider catalog remain optional.
This ADR creates no new runtime dependency.

## Rejected alternatives

- **Vendor-specific provider and model enums.** They would turn a declaration
  boundary into a release cadence coupled to vendors.
- **Editing a shared validation helper.** A new DARK boundary should not risk
  already-frozen runner or governance behavior.
- **A free-form metadata bag.** It would permit hidden credentials and
  unreviewed capability claims.
- **Connectivity and catalog in one batch.** Provider calls, authentication,
  retries and live truth require their own reversible batch and evidence.
- **Partial salvage.** Silently dropping an invalid model makes the projection
  appear more authoritative than the declaration supplied.

## Consequences

Later batches can consume a small provider-neutral vocabulary, but they must
add their own explicit acquisition, authorization and evidence boundaries.
B1 alone cannot show a provider as connected, healthy or usable and cannot
execute a model.

## Rollback

Rollback is one additive commit: remove the two catalog modules, their focused
test and release evidence, then restore the single Sprint 8 plan bullet. No
data, credential, lease, process or external provider record can be stranded.
