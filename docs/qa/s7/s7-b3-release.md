# S7.B3 release evidence

## Discover and frame

`S7.B2` froze a pure, fail-closed authorization predicate over one normalized
GitHub App installation/repository scope, while deliberately leaving the
question of current repository membership outside that boundary. `S7.B3`
tests the next independently reversible hypothesis: a read-only source port and
an in-memory fixture adapter can own one installation snapshot, prove exact
repository membership and emit only canonical `GitHubInstallationScope`
values, without adding a GitHub caller, credential or effect path.

Fable's architecture decision was to keep three boundaries separate:

1. a future provider adapter discovers the current installation, permission and
   repository-selection snapshot;
2. this source boundary normalizes that snapshot and proves exact membership;
3. the frozen `S7.B2` predicate decides whether one normalized scope is
   necessary authority for a frozen effect descriptor.

This batch implements only the second boundary with caller-supplied fixture
data. It makes no freshness, durability or provider-authentication claim.

## Design and threat boundary

Delivered:

- fixture spec version
  `nexusos.github-installation-source-fixture.v1`;
- an async read-only `GitHubInstallationScopeSource.readScope` port keyed only
  by `installationId` and `repositoryId`;
- a fixture adapter for one installation with `active | suspended` state,
  `all | selected` repository-selection metadata, a canonical permission map
  and an explicit `0..500` repository snapshot;
- strict normalization through the frozen `S7.B1` repository parser and
  `S7.B2` installation-scope parser;
- exact membership by both installation and repository ID;
- duplicate rejection by repository ID and normalized `owner/name`;
- canonical permission ordering independent of fixture property order;
- copy-on-create snapshot ownership and a newly parsed independent scope on
  every successful read.

`repositorySelection: all` is descriptive and does not grant an absent
repository. Both `all` and `selected` fail closed to the exact repositories in
the supplied snapshot. An empty snapshot authorizes no repository. A
`suspended` installation may be represented truthfully, but the downstream
`S7.B2` predicate denies every effect from that scope.

The source object is frozen and exposes only `readScope`. Lookup envelopes and
fixture records require exact enumerable data fields. IDs are canonical
positive decimal signed-int64 strings. Ordinary repository arrays require
contiguous own enumerable data slots and the exact `Array.prototype`; sparse
arrays, subclasses, symbols, accessors and hidden fields fail closed.
Permission names are snapshotted once from own keys, and repository-array
length is read once before structural validation, containing hostile
time-of-check/time-of-use behavior. The returned scope is reparsed and its two
IDs are rechecked against the lookup as a final postcondition.

The fixture adapter performs no network call, credential access, process
execution, route registration, webhook handling, persistence, provider token
exchange or GitHub effect. It is not a real/current GitHub installation
adapter. A future provider adapter must obtain and bound a fresh installation
snapshot before calling this boundary; it must not infer current membership
from `repositorySelection: all`.

The dark gate adds both installation-source modules to its explicit contract
allowlist and widens only its GitHub module-name scan to include
`github-installation-source`. Existing production-tree bans for SDK, network,
credential, storage, process and effect tokens remain unchanged.

## Verify

The final candidate passed:

- focused installation-source, authorization, delivery and dark-gate suite:
  33/33;
- TypeScript: pass;
- complete unit suite: 251/251;
- complete runner suite: 197/197;
- complete migration/preflight suite: 38/38;
- governance, presence, realtime, artifacts, runners, engine-keyring and runs
  integrations: pass;
- production build and rendered smoke: 2/2;
- ESLint and oxlint: pass;
- production dependency audit: 0 vulnerabilities;
- diff hygiene: exactly the six allowlisted source, test, plan and evidence
  paths; no route, worker, runner, migration, package, CI or configuration
  change.

The negative matrix covers unknown and excessive permissions, missing
`metadata:read`, duplicate repository IDs and normalized labels, crossed
installation/repository IDs, absent membership for both selection modes,
int64 boundaries, malformed envelopes and repositories, fixture mutation after
creation, mutation of returned scopes, accessors, symbols, inherited records,
sparse and exotic arrays, hostile reflection and single-snapshot permission
keys and array length. Distinct owners may truthfully contain repositories with
the same normalized name.

## Review

The first exact `claude-opus-5` adversarial review returned `PASS/GO`,
P0=0/P1=0 and five non-blocking P2 hardening recommendations. All five were
applied before release:

- permission membership now uses the one captured own-key set;
- the repository bound uses one captured array length;
- every returned scope has an explicit lookup-identity postcondition;
- the fixture test is statically checked with
  `satisfies GitHubInstallationSourceFixture`;
- the matrix now proves the one-method port, accessor-safe lookups,
  copy-on-read isolation, envelope and int64 bounds, and same-name repositories
  under distinct owners.

The final full-diff `claude-opus-5` review returned `PASS/GO`, P0=0/P1=0 and
two non-blocking P2 hygiene findings. The factory now captures only the
installation ID needed by the returned closure instead of retaining the parsed
fixture record, and parsed repository/permission collections are typed
read-only. The affected focused, unit, typecheck and lint gates passed again.
The exact-model delta review returned `PASS/GO`, P0=0/P1=0/P2=0 and confirmed
that both final-review findings and all five preliminary findings are closed.

## Release, rollback and learn

There is no preview or production behavior to promote because `S7.B3` remains
dark and read-only. Rollback removes the two installation-source modules and
their unit test, removes their two dark-gate allowlist entries and scan-name
extension, and reverts this plan/evidence update. No external data, credential
or effect can be stranded.

The next GitHub batch may implement a read-only provider port adapter that
obtains a bounded, current installation and selected-repository snapshot and
feeds this source contract. Provider authentication, token handling, durable
storage, webhook reconciliation and effects remain separate batches. UI labels
remain `roadmap` until a tested real provider path crosses this contract.

## Parallel integration evidence

The frozen S7.B3 candidate was integrated after the independently green
S6.B4.4a5.2 engine-recovery candidate. Their only shared path was the declared
`docs/PROGRAM-PLAN.md` hotspot, with disjoint hunks; production, contract,
test and fixture intersections were empty. The integration guard's synthetic
merge-tree and blob audit returned GO, P0=0/P1=0/P2=0.

Post-integration focused gates passed 54/54 engine-recovery tests and 23/23
GitHub delivery/source tests. The complete combined pipeline passed typecheck,
274/274 unit tests, 205/205 runner tests, 38/38 migration/preflight tests, all
seven integrations, build, 2/2 smoke, lint, zero-vulnerability production
audit, diff hygiene and a clean worktree.
