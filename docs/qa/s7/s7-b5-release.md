# S7.B5 release evidence

## Discover and frame

`S7.B4` froze a strict, provider-neutral `readPage` seam but deliberately
contained no transport implementation. `S7.B5` tests the smallest next
hypothesis: a read-only adapter can observe one current GitHub App
installation and its exact bounded repository membership without importing
credential ownership, durability, UI, webhooks or write effects.

The architecture gate ran in native Claude Code `2.1.219` with
`claude-fable-5`. Session `5263bb68-ca45-4076-8487-14160590a714` returned
`GO (condicional)` and required:

- caller-owned, in-memory App JWT and installation-token leases;
- two installation metadata reads around at most five repository pages;
- exact `total_count` convergence and an inclusive 500-repository ceiling;
- fixed origin, API version, deadlines, response-body and call limits;
- no internal retry, token generation, minting or persistence; and
- an explicit distinction between real production code and a product
  capability that still requires live-provider evidence.

The same Fable session accepted a delta correcting three points: discovery
requires only frozen `metadata:read`, not `contents`; a short page before the
declared total is failure rather than early success; and the GitHub allowlist
must remain disjoint from the S6 runner HTTP/serve batch.

## Delivered boundary

The new versioned contract fixes:

- GitHub REST origin `https://api.github.com`;
- REST version `2026-03-10`, checked against GitHub's published supported
  API-version list, a vendor JSON accept header and a bounded NexusOS user
  agent;
- 100 repositories per page, five repository pages and seven total GETs;
- ten seconds per request, 45 seconds per observation and two MiB per streamed
  response before JSON parsing;
- a 60-second lease-expiry safety margin;
- installation-bound `app-jwt` and `installation-token` leases with captured
  reveal/release methods; and
- a closed, redacted error vocabulary.

The adapter uses the App JWT only for
`GET /app/installations/{installationId}` and the installation token only for
`GET /installation/repositories?per_page=100&page=N`. Both requests reject
redirects and are constructed from fixed paths under the fixed GitHub origin;
provider links and arbitrary caller origins are never followed.

The first metadata read validates installation identity, active state,
`all|selected` selection, `metadata:read`, the frozen permission vocabulary,
provider revision and ETag. Repository pages accept only positive safe integer
IDs, canonical owner/name identity, exact page lengths and a stable total.
They reject more than 500 repositories, duplicates across ID or normalized
label, malformed UTF-8/JSON, oversized or failed streams and every unexpected
status. A final metadata read must match the first before the terminal B4 page
is released.

The fence is deliberately described as best effort. GitHub REST pagination is
not a transaction: a same-size repository swap that does not alter the
installation revision or ETag cannot be proven absent. B5 therefore claims an
exact membership for the bounded observation it collected, not a linearizable
point-in-time GitHub snapshot. Durable webhook reconciliation remains a later
batch.

Suspension returns a typed closed failure before repository enumeration; it
never fabricates an empty installation. Unknown granted permission names or
unsupported values fail closed for the dedicated least-privilege NexusOS App.
No permission outside the frozen vocabulary becomes NexusOS authority.

Lease secrets are acquired at most once, retained only inside the observation
closure, released exactly once on success or terminal failure and excluded
from pages, observations, errors, JSON and the live script output. The adapter
does not generate a JWT, read a private key, mint an installation token,
refresh a lease or store a credential.

The frozen B4 aggregator drains a valid adapter sequence to a terminal page.
A different future direct transport consumer that intentionally abandons
iteration before that page owns cancellation of its caller-side leases; B5
does not widen the frozen one-method B4 transport with a disposal method.

## Optional platform semantics

GitHub Free is permitted as the default work motor, but connection remains
optional at platform level. NexusOS can start and operate its internal project,
team, agent, collaboration and governance functions without GitHub. A project
that elects GitHub as its work motor has a project-scoped readiness
requirement; an absent or expired lease fails that project integration without
turning into ambient authority or a global platform dependency.

The opt-in live script is excluded from normal tests. It requires
`GITHUB_INSTALLATION_ID`, `GITHUB_APP_JWT`,
`GITHUB_APP_JWT_EXPIRES_AT`, `GITHUB_INSTALLATION_TOKEN` and
`GITHUB_INSTALLATION_TOKEN_EXPIRES_AT`, deletes those environment entries
after capture, performs only the adapter's GET path and emits count-only,
redacted evidence. Missing values exit `2` with `SKIP`; provider or contract
failure exits `1`; only a real source plus one exact repository lookup exits
`0` with `PASS`.

Run the live gate from the repository root without placing either token in a
command-line argument:

```sh
node --import tsx scripts/live/github-installation-discovery-live.mjs
```

An installation with zero repositories is valid provider state but cannot
prove the required live repository lookup. The script reports the truthful
`no_repository_in_installation` live-gate failure rather than calling the
provider response malformed.

## Scope and parallel safety

The exact allowlist is:

- `src/contracts/github-installation-discovery.ts`;
- `src/adapters/github/github-installation-discovery.ts`;
- `tests/unit/github-installation-discovery.test.ts`;
- the discovery exemption only in `tests/unit/github-delivery.test.ts`;
- `scripts/live/github-installation-discovery-live.mjs`;
- this evidence record; and
- the Sprint 7 subsection of `docs/PROGRAM-PLAN.md`.

No route, UI, worker, D1 schema, migration, package, CI, runner, engine or
effect file changes. S6.B4.4a5.4 owns the runner heartbeat/recovery HTTP
adapter and public serve command; S7.B5 owns only GitHub contract, adapter,
tests, live acceptance and Sprint 7 evidence. `docs/PROGRAM-PLAN.md` is the
only declared integration hotspot and the teams own disjoint sprint hunks.

All eight B1-B4 production modules are frozen byte-for-byte:

| Frozen module | SHA-256 |
| --- | --- |
| `src/contracts/github-authorization.ts` | `58cb9fbf9d8ce742f77d36cd17a7b51e10f3aa7036c6b3b8e91ab14b496e2ad3` |
| `src/contracts/github-delivery.ts` | `1d91877e192a6f72da036929998486bd410cc0ad988c257a3a9af7d9f6770ab3` |
| `src/contracts/github-installation-source.ts` | `c29c91e5142a2bbd4613b3c62c8dcc551e2f756f7595b36d3810e314df91d734` |
| `src/contracts/github-installation-snapshot.ts` | `e7cbe30d2a1273d4c4f98044e3447fe1cf1dec9321d9b961785f060deecc0eb9` |
| `src/domain/github/github-authorization.ts` | `59e028628b0f4ce054c76b121085e9aead9d1068052526eba1ccc95c5fdea265` |
| `src/domain/github/github-delivery.ts` | `7132125e094f2ae3d9d3cc6857820d5d0513a834daa3477a5ebdceda20e76c4e` |
| `src/domain/github/github-installation-source.ts` | `dcb5953d42c6fbcefed04ffc76d38ee41daffa5663f67f01d77c807e69285eff` |
| `src/domain/github/github-installation-snapshot.ts` | `acfabc0240d60da537351b4d39c485fdd7548857398c36391ce49932ad4f9ead` |

## Automated acceptance

The focused B1-B5 matrix covers:

- zero, one, 100, 101 and 500 repositories in exactly three through seven
  GETs, followed by frozen B4/B3 scope lookup;
- exact URL, method, redirect mode, auth class, API version, accept and user
  agent headers;
- opaque cursor sequencing and terminal reuse;
- overflow, total drift, premature short pages and duplicate identities;
- suspension, missing metadata, unsupported permission and metadata/ETag
  drift;
- malformed or unsafe provider IDs and repository labels;
- lease kind, installation binding, expiry, acquisition, release and canary
  redaction;
- 400/410 API-version, 401/403/404/429/5xx, primary and secondary rate
  classification, network, redirect and deadline failures with no retry;
- exact, declared and streamed two-MiB bounds, chunk overflow cancellation,
  broken streams, malformed JSON, invalid content type, BOM and invalid UTF-8;
  hostile input reflection without accessor execution; and
- live-script `SKIP` without credentials and secret-free stdout/stderr.

The focused B1-B5 suite passed 64/64. The complete unit suite passed 282/282.
TypeScript passed.

## Live truth label

No GitHub App credentials are present in this worktree. The opt-in live command
therefore returns `SKIP`, not `PASS`. The production adapter is real code and
its complete wire path is exercised against a loopback HTTP provider, but the
product capability remains `roadmap` until an operator supplies current,
installation-bound leases and records a redacted exit-zero run against
GitHub. Loopback success is never substituted for that live gate.

## Release gate

The final candidate passed:

- focused B1-B5 discovery/authorization/source/snapshot/delivery: 64/64;
- complete unit suite: 282/282;
- complete runner suite: 226/226;
- migration and preflight suite: 38/38;
- all seven governance, presence, realtime, artifacts, runners, engine-keyring
  and runs API integrations;
- production build and rendered-artifact smoke tests: 2/2;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities;
- eight frozen B1-B4 SHA-256 checks; and
- exact allowlist plus `git diff --check`.

The first exact `claude-opus-5` candidate review in session
`62ab88fc-a5d5-4e19-8208-57c19ee3a6bb` returned `PASS/GO`, P0=0, P1=2,
P2=6. Both P1s were closed before release: the three real discovery files now
have a compensating static fence against new origins, mutative HTTP verbs,
network/filesystem/process imports and file writes; HTTP 400 and 410 both map
to the tested `api_version_unsupported` failure.

The inexpensive P2 hardening was also closed: hostile input reflection, exact
body bounds, failed streams and total-deadline preflight gained executable
coverage; zero-repository live state and intentional iteration abandonment
are truthful; the live command is explicit; and the verb fence rejects any
standalone `DELETE|PATCH|POST|PUT` token. Two same-session delta reviews ended
with exact-model `PASS/GO`, **P0=0, P1=0, P2=0** and no permission denial.

## Parallel integration evidence

S7.B5 was integrated after the critical-path S6.B4.4a5.4 commit. The
independent guard found only the declared `docs/PROGRAM-PLAN.md` intersection,
with no shared production, contract or test file. Its A-first merge tree was
clean, and the real cherry-pick reproduced the exact synthetic tree
`01250e835637ac78e4455647945a372a441563a5` and plan blob
`23d3b3d273e883545e9cfdc23325781e495c31fa` without manual resolution.

All eight B1-B4 hashes remained exact. Post-integration focused gates passed
64/64 for GitHub B1-B5 and 139/139 for serve/recovery. The complete combined
pipeline passed 282/282 unit tests, 262/262 runner tests, 38/38
migration/preflight tests, all seven API integrations, production build, 2/2
smoke, lint, diff hygiene and a zero-vulnerability production audit.

The live gate without credentials still returns `SKIP`, exit 2. This
integration evidence does not promote the GitHub capability beyond
`roadmap`; a redacted real-provider PASS remains required.

## Rollback

Rollback removes the new contract, adapter, test, live script and evidence
record, restores the one dark-gate exemption and removes the S7.B5 plan
paragraph. No credential, record, schema, route, worker, webhook, provider
process or external write can be stranded. The eight frozen B1-B4 modules
remain the exact pre-B5 boundary.
