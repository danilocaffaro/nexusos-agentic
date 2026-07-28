# S7.B6 release evidence

## Discover and frame

`S7.B5` can make one bounded, read-only observation of a GitHub App
installation, but it does not acquire Issue or pull-request content and it
does not map provider objects into the sovereign Nexus work graph. `S7.B6`
tests the smallest independently reversible next hypothesis: frozen B1
Issue/PR evidence and lineage can become a deterministic work-identity
projection without importing data, writing state or making GitHub a global
runtime dependency.

The architecture gate ran in native Claude Code `2.1.219` with exact model
`claude-fable-5`. Session `d30a9126-e853-419a-95e8-e74c7e115041` returned
`GO (condicionado)` and fixed these boundaries:

- consume only the frozen B1 evidence and lineage vocabulary;
- emit a pure, title-less, all-or-nothing projection;
- keep Pull Requests as external evidence rather than local work;
- preserve provider state without translating it into Nexus workflow state;
- bound both evidence and lineage to 500 entries;
- treat caller-supplied lineage as unverified observation, never authority;
- add no provider caller, persistence, route, UI, webhook, credential or
  effect.

The independent QA oracle initially found a time-of-check/time-of-use weakness
inherited from passing hostile proxies through the otherwise strict B1
parsers. B6 now reparses every B1 result from its newly materialized plain
snapshot, including the public reference builder. Shifting and throwing proxy
regressions prove that malformed second reads fail closed. The oracle's final
verdict is `GO`, P0=0 and P1=0.

## Delivered boundary

The new input envelope is
`nexusos.github-work-observation.v1`. It contains one exact repository, at
most 500 Issue/PR evidence values and at most 500 lineage edges. The projector
returns `undefined` for the entire envelope when any value is malformed,
out-of-scope, ambiguous or dangling. There is no partial salvage.

Artifact references use:

```text
github:repository:{repositoryId}:issue:{number}
github:repository:{repositoryId}:pull_request:{number}
```

This intentionally differs from B1 effect-target references. Installation IDs
belong to an authorization context and may change after reinstall; repository
IDs are the durable identity anchor across reinstall and rename. Every
evidence value and lineage edge must still match all four repository fields,
including installation ID, inside the supplied observation.

Issue and Pull Request identities include `kind + repositoryId + number`.
Duplicate numbers in any Issue/Issue, PR/PR or Issue/PR combination reject the
whole envelope. This forces a future caller to remove the issue-shaped REST
shadow of a Pull Request before projection instead of guessing silently.
Duplicate provider IDs reject within their own Issue or Pull Request identity
space. Equal numeric IDs across those independent kinds remain valid.

An open untracked Issue becomes an external node with disposition `proposed`
and one title-less proposal carrying:

- `claim: proposal_only_no_import`;
- explicit Issue ID, number and reference;
- the same reference as `suggestedExternalRef`;
- constant `suggestedKind: task`;
- constant `suggestedStatus: backlog`.

The proposal is deliberately non-importable by construction because it has no
title, while persisted Nexus work requires one. An open Issue with one
`tracked_by` edge becomes `tracked` and emits no proposal. A closed Issue is
always `observed_only` and emits no proposal, even when it retains a
caller-asserted `trackedWorkItemId` and lineage edge. Here, disposition means
operational eligibility for a future proposal, not absence of a historical
link; provider closure never skips the local work-item transition rules.

Every Pull Request is `evidence_only`; it never becomes a WorkItem. Its
provider state, draft flag, head SHA and optional merge SHA remain available
as read-only facts and as join keys for B7. An `implemented_by` link requires
both its Issue and Pull Request to be present.

All GitHub endpoints in accepted lineage must exist in accepted evidence. A
Nexus WorkItem endpoint in `tracked_by` is the sole deliberate external-node
exception: it is represented by an explicit `sourceWorkItemId` and
`nexus:work_item:{id}` reference, labeled by the root
`lineageClaim: caller_asserted_unverified`. The projection neither verifies
that local record nor treats the edge as authorization.

Tracking is injective in both directions: one WorkItem cannot track two Issues
and one Issue cannot be claimed by two WorkItems in one observation. Repeated
edge triples are invalid even when their caller-supplied recorded times differ.
Issue-to-PR implementation may be many-to-many because a change can implement
multiple Issues and an Issue can require multiple changes.

`latestObservedAt` is the maximum canonical timestamp from Issue/PR evidence
or `null` for an empty observation. Lineage recording time is excluded. This
is bounded caller-supplied freshness, not a claim of sync, current provider
state or durability.

The output is sorted with locale-independent code-unit comparison, recursively
frozen and detached from input objects. Exact own enumerable data keys,
ordinary contiguous arrays and plain/null-prototype records are required.
Extra, symbol, hidden, inherited, accessor, sparse, exotic, throwing and
shifting values fail closed without escaping an exception.

## Optional platform and truth label

GitHub remains optional at platform level. Local projects, objectives,
WorkItems, teams, agents, rooms, governance and artifacts continue to operate
without GitHub, Jira or another paid service. A project may later elect the
GitHub Free work motor, but this dark projection does not create that
dependency.

The product capability “Issues and PRs mapped to the Nexus work graph” remains
`roadmap`. B6 proves only identity mapping over caller-supplied B1 facts. It has
no acquisition path, title, governed import, reconciliation, storage, route or
UI. No existing UI truth label changes.

A B6 live gate would be both redundant and dishonest: this module has no
provider communication, while the opt-in B5 gate already owns real
installation discovery and truthfully skips without credentials. B6 therefore
uses only a static/fixture gate. Fixture success never substitutes for
real-provider or governed-import acceptance.

## Scope and rollback

The exact allowlist is:

- new `src/contracts/github-work-projection.ts`;
- new `src/domain/github/github-work-projection.ts`;
- new `tests/unit/github-work-projection.test.ts`;
- only two module entries and one scan-name extension in
  `tests/unit/github-delivery.test.ts`;
- this release evidence; and
- only the Sprint 7 and declared parallel-pair hunks in
  `docs/PROGRAM-PLAN.md`.

No runner, database, migration, route, UI, worker, webhook, live script,
package, lockfile, CI or provider adapter is changed. The static dark gate
includes both new production modules and rejects network, process, database,
credential and provider-origin vocabulary. It also prevents undeclared
production consumers.

All inherited production boundaries remain byte-identical:

| Frozen module | SHA-256 |
| --- | --- |
| `src/contracts/github-delivery.ts` | `1d91877e192a6f72da036929998486bd410cc0ad988c257a3a9af7d9f6770ab3` |
| `src/contracts/github-authorization.ts` | `58cb9fbf9d8ce742f77d36cd17a7b51e10f3aa7036c6b3b8e91ab14b496e2ad3` |
| `src/contracts/github-installation-source.ts` | `c29c91e5142a2bbd4613b3c62c8dcc551e2f756f7595b36d3810e314df91d734` |
| `src/contracts/github-installation-snapshot.ts` | `e7cbe30d2a1273d4c4f98044e3447fe1cf1dec9321d9b961785f060deecc0eb9` |
| `src/contracts/github-installation-discovery.ts` | `d802fa9cc890deab459ecc4a8f104fc819b269fb95022bba5ff4ffd0eb4a527b` |
| `src/contracts/work-graph.ts` | `0002b0795039a803fcdb1c1d5fa94dd2bff6ffa507ab4feebefac08178dbea9e` |
| `src/domain/github/github-delivery.ts` | `7132125e094f2ae3d9d3cc6857820d5d0513a834daa3477a5ebdceda20e76c4e` |
| `src/domain/github/github-authorization.ts` | `59e028628b0f4ce054c76b121085e9aead9d1068052526eba1ccc95c5fdea265` |
| `src/domain/github/github-installation-source.ts` | `dcb5953d42c6fbcefed04ffc76d38ee41daffa5663f67f01d77c807e69285eff` |
| `src/domain/github/github-installation-snapshot.ts` | `acfabc0240d60da537351b4d39c485fdd7548857398c36391ce49932ad4f9ead` |
| `src/domain/work-graph/transitions.ts` | `ed223c5042933606aae7547b9e12b534a23c5684b7a586b62a5a5702a725b025` |
| `src/domain/work-graph/index.ts` | `5e21d878bd6f0298fb85cfed66a1e08dbddae497227ebfe8458c9ef2aa863430` |
| `src/adapters/github/github-installation-discovery.ts` | `65b2edad4802f516b0b70a4b2a97e7c9862977e78f31bfba740c49900d532520` |
| `scripts/live/github-installation-discovery-live.mjs` | `796283c0e63d967e154491dba14f810b3d25e53497db45f579ea3df2f8d80bc2` |

Rollback removes the two additive modules, their focused test and evidence,
removes the dark-gate entries/scan extension and reverts the two plan hunks.
No data, credential, lease, external record or process can be stranded.

## Automated acceptance

The focused B1-B6 matrix passes 80/80 and covers:

- exact version, repository scope and durable artifact-reference grammar;
- open/untracked, open/tracked and closed/tracked Issue semantics;
- open, closed and merged PRs as evidence only;
- all-or-nothing rejection of B7 kinds and relations;
- exact repository identity and closed GitHub endpoint membership;
- Issue/PR number shadows, provider-ID conflicts and tracking ambiguity;
- repeated lineage triples and dangling Issue/PR endpoints;
- accessor, symbol, hidden, inherited, sparse, exotic and throwing values;
- shifting proxies across repository, evidence, lineage and the public builder;
- inclusive 500-evidence and 500-lineage limits;
- deterministic ordering across input permutations;
- deep output freeze, copy ownership and mutation isolation; and
- evidence-only freshness that excludes lineage recording time.

The complete independent candidate pipeline was rerun after the provider-ID
split and all adversarial test additions, and passed:

- TypeScript and the focused B1-B6 matrix: 80/80;
- complete unit suite: 298/298;
- complete runner suite: 262/262;
- migration and preflight suite: 38/38;
- all seven governance, presence, realtime, artifacts, runners, engine-keyring
  and runs API integrations;
- production build and rendered-artifact smoke tests: 2/2;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities; and
- exact allowlist, frozen hashes and `git diff --check`.

The same exact-model Fable session reviewed the complete delta read-only after
the pipeline. It accepted the 467 raw production lines as auditable invariant
code rather than a complexity blocker, returned `GO`, P0=0/P1=2, and required
two closures before handoff. The independent Issue and Pull Request provider
ID sets now accept honest cross-kind numeric equality while retaining
within-kind uniqueness, with a direct regression. This section records the
complete post-correction green candidate pipeline.

The final exact-model `claude-opus-5` review ran in session
`065aaf75-1322-41f8-8438-8305c18c207b`. Its initial independent verdict was
`PASS/GO`, P0=0, P1=0 and P2=3. All three inexpensive P2 hardenings were closed:
the production line count and post-correction pipeline provenance are exact;
unknown versions and non-record inputs are covered; and repeated
`implemented_by` triples with different recording times are rejected by a
direct regression. A same-session read-only delta returned `PASS/GO`,
P0=0/P1=0 and only the now-corrected provenance sentence as a residual
non-blocking P2. No code or test changed after the final green pipeline.

## Next batch

S7.B7 may map frozen B1 check-run and deployment evidence in a separate module
joined through the Pull Request head SHA retained here. It must not edit B6.
Provider text acquisition, governed WorkItem import, temporal reconciliation,
webhooks, persistence and every GitHub write effect remain later independent
batches.
