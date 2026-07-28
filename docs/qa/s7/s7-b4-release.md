# S7.B4 release evidence

## Discover and frame

`S7.B3` proved that one caller-supplied fixture-v1 snapshot can become a
read-only, exact-membership installation scope source. It deliberately did not
define how a future provider boundary supplies a multi-page current snapshot.
`S7.B4` tests that next independently reversible hypothesis: an injected
one-method transport can return untrusted page documents to a strict,
bounded aggregator that produces the exact B3 fixture shape and delegates final
scope construction to the frozen B3 source.

Fable approved four separate responsibilities:

1. this batch freezes a versioned page envelope and injected transport seam;
2. the aggregator validates, copies and combines a bounded sequence of pages;
3. frozen B3 validates the complete fixture and owns exact membership;
4. a later adapter may implement provider communication and authentication.

Only the first two responsibilities are new here. The transport implementation
is absent, so this batch makes no provider identity, freshness, authentication,
durability or availability claim.

## Design and threat boundary

Delivered:

- page spec `nexusos.github-installation-snapshot-page.v1`;
- an injected `readPage` transport whose input contains only a zero-based page
  index and an opaque nullable cursor and whose output is `unknown`;
- a strict page normalizer that requires exact page, installation, permission
  and repository envelopes;
- an inclusive `0..500` repository bound, at most 500 page calls and a
  1,024-character bound for each non-null opaque cursor;
- exact echo checks for page index and cursor, a unique-cursor rule and
  bounded cursor progress for every continuation, including empty intermediate
  pages;
- invariant installation facts, permissions and total count across all pages;
- exact terminal convergence: a null next cursor succeeds only when the
  aggregate count equals the declared total;
- construction of one exact
  `nexusos.github-installation-source-fixture.v1` value followed by delegation
  to frozen `createGitHubInstallationFixtureSource`;
- end-to-end return of the frozen B3 `GitHubInstallationScopeSource`.

The aggregator captures the one `readPage` function before the first call and
passes a frozen two-field page input on every call. Every untrusted record is
snapshotted from one own-key list and one descriptor read per property.
Snapshots use null-prototype records, preventing the special `__proto__` key
from mutating the copy or disappearing from exact-key validation. Arrays must
use the exact `Array.prototype`, one captured own length descriptor and
contiguous enumerable data slots. Symbols, hidden properties, accessors,
sparse arrays, subclasses and hostile reflection fail closed.

All values retained across an `await` are copied primitives or newly allocated
plain records. Later transport or page mutation cannot rewrite already accepted
installation, permission or repository facts. Duplicate repository IDs and
duplicate normalized `owner/name` labels are rejected by frozen B3 after full
aggregation. `repositorySelection: all` remains descriptive: the resulting
source contains only the exact repositories observed in this bounded snapshot.
Empty and suspended snapshots remain truthful without adding authority.

No transport implementation, built-in provider call, credential, process,
route, worker, webhook, persistence, migration, package, UI or GitHub effect is
added. The seam does not connect to GitHub by itself. Every GitHub capability
therefore remains `roadmap`.

The dark gate retains its existing banned-token expression, adds only the two
snapshot modules to the explicit GitHub module set and extends the internal
module-name isolation scan to `github-installation-snapshot`. The six frozen
B1-B3 GitHub modules remain byte-identical.

## Verify

The final candidate passed:

- focused B1-B4 GitHub snapshot/source/authorization/delivery and dark-gate
  suite: 46/46;
- TypeScript: pass;
- complete unit suite: 264/264;
- complete runner suite: 205/205;
- complete migration/preflight suite: 38/38;
- governance, presence, realtime, artifacts, runners, engine-keyring and runs
  integrations: pass;
- production build and rendered smoke: 2/2;
- ESLint and oxlint: pass;
- production dependency audit: 0 vulnerabilities;
- frozen-module SHA-256 check: all six B1-B3 modules byte-identical to
  integrated `29a8328`;
- diff hygiene: exactly the six allowlisted source, test, plan and evidence
  paths; no route, worker, runner, migration, package, CI or configuration
  change.

The adversarial matrix covers multipage end-to-end `readScope`, exact opaque
cursor forwarding, `all` membership, totals above 500, a 501-entry page,
inconsistent totals/installation/permissions, early and late termination,
overlapping and duplicate identities, cursor cycles, later mutation of earlier
pages and the transport method, suspended and empty snapshots, valid and
nonterminal 500-call boundaries, page/cursor echo mismatches, cursor bounds,
unknown fields, accessors, symbols, sparse and exotic arrays, reflection
failures, transport rejection and own enumerable `__proto__` fields on page,
installation, permissions and repository envelopes.

One post-hardening orchestration pass encountered an existing ignored-cache
state miss in the final runs integration after prior local builds. Moving only
generated `.vinext`, `.wrangler`, `dist` and typecheck-cache artifacts to a
recoverable temporary directory restored clean temporary D1 persistence; the
exact runs integration, build and smoke then passed without a source change.

## Review

The independent integration guard found one blocking P1 before the complete
pipeline, independently confirmed by a preliminary exact-model Opus review:
copying untrusted keys into `{}` let an own enumerable `__proto__` field mutate
the local snapshot prototype and escape `Object.keys`. The copy target is now
`Object.create(null)`, and four envelope-level regressions prove the field
remains visible and is rejected without polluting `Object.prototype`. Focused
tests, typecheck and lint passed again after the correction.

The same preliminary review supplied non-blocking hardening that was also
closed before the release pipeline: the page-input type no longer carries
Web-API-adjacent `Request` vocabulary; the transport function declares
`this: void`; an empty intermediate page may advance through a unique bounded
cursor; and the matrix now covers state/selection drift, exact transport
surface, permission minima, the inclusive maximum cursor and invalid
repository identity delegation to B3.

The final exact-model `claude-opus-5` review returned `PASS/GO`, P0=0/P1=0 and
three non-blocking P2 carry-forwards:

- the injected transport promise has no internal liveness deadline; a future
  real adapter must own timeout and cancellation without adding that policy to
  this pure boundary;
- JavaScript negative zero is accepted as semantically identical to zero for
  page index and total count;
- `{ issues: "write" }` is rejected because `metadata:read` is absent, but the
  direct matrix proves the same invariant through `{}` and
  `{ metadata: "write" }` rather than that exact redundant shape.

The review confirmed the `__proto__` fix end to end, pagination/membership,
TOCTOU/copy isolation, dark scope, documentation and rollback all `pass`.

## Release, rollback and learn

There is no preview or production behavior to promote because `S7.B4` remains
dark and has no transport implementation. Rollback removes the two snapshot
modules and their test, removes the two dark-gate module entries and scan-name
extension, and reverts this plan/evidence update. No data, credential or
external effect can be stranded.

A later batch may supply a separately reviewed provider adapter to the frozen
transport port. Provider authentication, credential handling, rate limits,
durable snapshots, webhook reconciliation and every write effect remain
separate batches. UI labels remain `roadmap` until a tested real path crosses
the contract.
