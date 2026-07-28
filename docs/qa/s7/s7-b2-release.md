# S7.B2 release evidence

## Discover and frame

`S7.B1` froze GitHub delivery identities, evidence, lineage and effect intent
descriptors, but intentionally authorized none of those effects. `S7.B2` tests
the next independently reversible hypothesis: one schema-free, per-repository
GitHub App installation scope can make a pure least-privilege decision for
every frozen GitHub effect without adding a credential, caller, port, route,
webhook, database record or network dependency.

Fable's architecture decision was to keep installation/repository
authorization separate from both provider authentication and effect execution.
GitHub Apps use fine-grained repository permissions and installation repository
selection; classic OAuth repository scopes are broader and are not an input to
this boundary. User login may later establish identity, but it does not grant
repository effects through `authorizesEffect`.

The permission names and endpoint matrix were checked against GitHub's official
documentation for
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[issues](https://docs.github.com/en/rest/issues/issues),
[pull requests](https://docs.github.com/en/rest/pulls/pulls),
[review requests](https://docs.github.com/en/rest/pulls/review-requests) and
[deployments](https://docs.github.com/en/rest/deployments/deployments).
These repository permission surfaces are available without a paid GitHub plan.
This batch does not depend on Jira, Slack or a paid GitHub feature.

## Design and threat boundary

Delivered:

- spec version `nexusos.github-installation-scope.v1`;
- closed installation states `active | suspended`;
- closed repository selections `all | selected`;
- closed repository permissions `metadata`, `issues`, `pull_requests`,
  `checks`, `deployments` and `contents`;
- closed permission access levels `read | write`, with `metadata` restricted to
  `read`;
- a canonical `GitHubInstallationScope` bound to one normalized
  installation/repository identity;
- a strict, exact-key, copy-on-parse `parseGitHubInstallationScope`;
- a pure `authorizesEffect(scope, descriptor)` that reparses both arguments,
  requires an active installation and exact repository identity, then applies
  the frozen least-privilege matrix.

Permission grants must be unique and strictly ordered by the exported canonical
permission vocabulary. `metadata:read` is mandatory and first. Ordinary arrays
with own data slots are accepted; sparse arrays, symbols, accessors,
non-enumerable fields, inherited records, array subclasses, duplicate or
reordered grants, unknown permissions, excessive access levels and malformed
repositories fail closed. Both exported runtime boundaries catch hostile
JavaScript reflection failures and return `undefined` or `false`.

`repositorySelection` records whether GitHub selected all repositories or an
explicit subset. It does not widen the normalized scope: one scope authorizes
only the exact `installationId`, `repositoryId`, canonical owner and repository
name it carries. A later adapter must construct one current scope only after it
has verified that this exact repository belongs to the installation's current
selection.

### Least-privilege effect matrix

| Frozen action | Required repository permission |
| --- | --- |
| `github.issue.create` | `issues:write` |
| `github.issue.update` | `issues:write` |
| `github.pull_request.create` | `pull_requests:write` |
| `github.pull_request.request_review` | `pull_requests:write` |
| `github.pull_request.merge` | `contents:write` |
| `github.deployment.promote` | `deployments:write` |

The merge endpoint requires `contents:write`, not merely
`pull_requests:write`. That permission can also mutate repository contents, so
this predicate is necessary but never sufficient authorization for an effect.
A future executor must additionally validate the frozen action/target pair,
current installation token attenuation, governance intent, parameters hash,
idempotency key and effect receipt. Similarly, GitHub represents pull requests
through issue-shaped APIs in some operations; the future adapter must not treat
`issues:write` as generic pull-request authority.

`checks` is recognized for later evidence reads but authorizes none of the six
effects. Classic OAuth scopes, tokens, private keys, JWTs and installation
credentials are deliberately absent.

The dark gate now scans all four GitHub contract/domain modules for network,
SDK, credential, process, storage and provider-call tokens. Its repository-wide
scan was widened from `github-delivery` to both `github-delivery` and
`github-authorization`, while preserving the complete production-tree scan and
only adding the two new modules to the explicit dark allowlist.

## Verify

The code candidate passed:

- focused authorization suite: 10/10;
- combined GitHub authorization/delivery suite and dark gate: 20/20;
- TypeScript: pass;
- complete unit suite: 238/238;
- complete runner suite: 169/169;
- complete migration/preflight suite: 38/38;
- governance, presence, realtime, artifacts, runners, engine-keyring and runs
  integrations: pass;
- production build and rendered smoke: 2/2;
- ESLint and oxlint: pass;
- production dependency audit: 0 vulnerabilities;
- diff hygiene: no route, port, schema, migration, worker, runner, app,
  package, CI or configuration change.

The negative matrix covers exact-key and property-descriptor confusion,
null-prototype records, spec drift, suspension, repository-selection drift,
cross-installation and cross-repository identities, read-only and unrelated
write grants, all six action/permission pairs, `checks:write` non-authority,
hostile proxies and an array subclass whose inherited iterator disagrees with
its own serialized data.

## Review

The first exact `claude-opus-5` adversarial review returned `FAIL/NO-GO`,
P0=0/P1=2. One P1 was introduced by this slice: an `Array` subclass could
provide permission grants through an inherited iterator while serializing as
an empty array. The parser now requires the exact `Array.prototype`, validates
every own index as an enumerable data property and reads only by numeric index.
The regression proves that both parsing and effect authorization fail closed.

The other reported P1 was the already accepted `S7.B1` hostile-Proxy
carry-forward: standalone delivery parsers may throw when JavaScript reflection
itself throws. That module is outside the `S7.B2` allowlist and was not changed.
The new parser and predicate wrap their complete bodies, including every call
into `S7.B1`, so the inherited failure is structurally contained and cannot
become an authorization or effect from this boundary. The delta Opus 5 review
accepted this isolation and returned `PASS/GO`, P0=0/P1=0, with the effect
matrix correct 6/6.

Non-blocking carry-forwards are helper duplication between the two dark domain
modules, documentation of the ordinary-array length invariant and a future
barrel-import evasion if a barrel is ever added. There is no barrel today.
These do not activate or widen authority.

## Release, rollback and learn

There is no preview or production behavior to promote because `S7.B2` remains
dark. Rollback removes the two authorization modules, their test file, the two
dark-gate allowlist entries and this plan/evidence update. No data, credential
or external effect can be stranded.

The next GitHub batch may add a read-only port and fixture adapter that
normalizes a current installation plus repository selection into this scope.
It must not combine token persistence, effect execution, webhook intake or
durable evidence in the same batch. UI labels remain `roadmap` until a tested
real path crosses the contract.
