# S7.B1 release evidence

## Discover and frame

GitHub Free is the planned default work and release motor, but the repository
previously had no stable vocabulary connecting one authorized installation to
repository work, checks, deployments, lineage or governed effects. Building an
adapter first would let GitHub response shapes and mutable names leak into the
work graph and `ActionIntent` boundary.

S7.B1 tests the hypothesis that one schema-free, fail-closed normalization
contract can freeze those meanings without activating an integration. The
acceptance outcome is pure parsing and stable target references; a malformed
or contradictory fact is rejected and no external action becomes reachable.

## Design and threat boundary

Delivered:

- canonical installation/repository identity using decimal int64 IDs plus
  in-parser ASCII case-folding to normalized lowercase owner/name labels;
- strict, exact-key issue, pull-request, check-run and deployment evidence;
- lowercase 40-hex commit identity and UTC millisecond timestamps;
- bounded GitHub numbers plus character-bounded names and environment strings;
- closed state/conclusion vocabularies and chronological consistency matrices;
- five directed lineage shapes joining Nexus work, issue, PR, commit, check
  and deployment subjects;
- six GitHub effect action types with exact target-kind pairing and a stable,
  installation-scoped `ActionIntent.targetRef`.

The parsers reject unknown fields, symbols, inherited records, accessors,
non-enumerable fields, out-of-range identifiers, noncanonical timestamps,
non-NFC/lone-surrogate/control and selected bidi/invisible text, inconsistent
terminal states and reversed event chronology. Owner and repository labels
must be ASCII and are case-folded rather than rejecting GitHub's
case-preserving REST values. They copy the repository identity instead of
retaining the input object.

This batch contains no external network call, OAuth or secret, GitHub route,
webhook receiver, schema/migration, repository adapter, UI, outbox, runner
change or effect executor. The new automated dark gate scans both production
modules for effect-capable APIs and the complete production source tree
(including scripts, ports, domains, examples and root config) for an early
contract import.

## Verify

The exact candidate passed:

- focused GitHub delivery suite: 10/10;
- TypeScript: pass;
- complete unit suite: 228/228;
- complete runner suite: 153/153;
- complete migration/preflight suite: 38/38;
- governance, presence, realtime, artifacts, runners, engine-keyring and runs
  integrations: pass;
- production build and rendered smoke: 2/2;
- ESLint and oxlint: pass;
- diff hygiene: no schema, migration, route, adapter, worker, app or runner
  change.

The focused suite covers accepted representatives and negative/boundary
matrices for int64/int32 identifiers, repository labels, exact keys, symbol
keys, prototype inheritance, property descriptors, issue closure, PR
merge/draft facts, queued checks with or without `startedAt`, every other check
phase, every deployment state, chronological ordering, text normalization,
all five non-self lineage edges, every action/target pair and activation
absence.

## Review

The first exact `claude-opus-5` adversarial review returned `FAIL/NO-GO`,
P0=0/P1=3. It found a 20-digit int64 comparison hole, rejection instead of
case-folding for case-preserving GitHub repository labels, and an invalid
assumption that a queued check cannot have `startedAt`. All three blockers
were corrected. The same hardening delta also rejects accessors/non-enumerable
fields and dangerous Unicode, excludes issue/PR self-lineage, distinguishes
deployment creation from status creation time and widens the dark gate to the
complete production source tree.

The post-fix Opus 5 re-review returned `PASS/GO`, P0=0/P1=0/P2=1. Its sole P2
showed that JavaScript Unicode lowercasing could map a Kelvin sign to ASCII
`k`. The final hardening now rejects every non-ASCII owner/name code point
before lowercasing and freezes the Kelvin-sign case. A final compact Opus 5
delta returned `PASS/GO`, P0=0/P1=0/P2=0/P3=2. The two non-blocking P3
carry-forwards are hostile `Proxy` behavior outside ordinary JSON records and
minor future-maintenance observations around local parser conventions/types.

Adapter note: GitHub's PR `state` must be normalized to `merged` only from
positive merge evidence. An open PR's synthetic/test `merge_commit_sha` must
never populate `mergeSha`. Target refs intentionally identify the installation
and affected repository/resource; `actionType`, canonical parameters hash and
idempotency key distinguish effects that share a repository target.

## Release, rollback and learn

There is no preview or production behavior to promote because S7.B1 is dark.
Rollback removes the two production modules, their tests and this plan/evidence
update. No data or external effect can be stranded.

The next batch may introduce installation/repository authorization behind a
port, but must not combine credentials, routes, persistence, webhook intake or
effect execution into this contract batch. Later evidence storage must preserve
the installation/repository IDs and chronology frozen here; UI capability
labels remain `roadmap` until a tested real path exists.
