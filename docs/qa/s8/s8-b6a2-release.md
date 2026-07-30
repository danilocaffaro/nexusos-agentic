# S8.B6a2 release evidence

## Discover and frame

S8.B6a2 tests one reversible product hypothesis: NexusOS can replace the
provider demo atomically with a real, read-only catalog surface while preserving
the B6a1 declared-only trust boundary.

The corrected architecture and batch split ran in Claude Code with exact model
`claude-fable-5`, session `221911c0-1250-4d3b-b876-b8eb5408e2b3`. It returned
`GO`, P0=0 and P1=0 for this exact six-path allowlist. The implementation base
is `main@72f9c2aee9551ce12c88ca73c4b835f02c53445a`, tree
`73e2a6a4aff484d002c05f8b043a4da43d72c2de`.

## Delivered visible slice

`app/providers-view.tsx` is the sole visible consumer of the B6a1 client
boundary. It:

- issues one member-scoped, `no-store` GET to `/api/providers/catalog`;
- maps 401, 403, invalid payload and unavailable transport to closed states;
- renders only the hostile-total, detached B6a1 projection;
- exposes the bundled source and its validated declaration SHA-256;
- labels every provider, method and model fact as declared and unverified;
- aborts superseded requests and ignores stale async completions; and
- aborts the active request when the view unmounts.

The root marks the loading boundary with `aria-busy`. Loading is announced with
`role=status`; authentication, membership and unavailable outcomes use
`role=alert`; the live region is atomic. The retry control exists only for an
unavailable catalog and repeats the same read-only GET.

`app/page.tsx` removes the complete hard-coded provider array and embedded demo
view in the same batch, imports the new view directly, and changes the command
palette label from a session claim to a declared-catalog action. No fallback
demo remains.

## Truth and effect boundary

The visible surface never claims that a provider, OAuth account or CLI session
is connected, authenticated, healthy, usable, available or within quota. The
catalog GET has no digest response header; B6a2 therefore displays the
lowercase SHA-256 already exact-parsed from `sourceRef`. Header-to-catalog digest
binding remains unused until the separate B6b observation flow.

There is no observation request, OAuth flow, provider call, CLI process,
credential, secret, timer, polling loop, WebSocket, persistence, route, schema,
migration, CSS, dependency or package-script change. The product capability
remains `roadmap`.

## Test evidence

Focused tests freeze:

- the real B5 catalog envelope and its Anthropic/OpenAI declared projection;
- exact 401, 403, invalid-success and unavailable state mapping;
- honest server-rendered loading state with no pre-settlement provider claim;
- `aria-busy`, atomic live status and alert semantics;
- every new constant copy string against the B6a1 positive-claim guard;
- atomic removal of all fabricated account, workspace, heartbeat, health,
  reauthentication and connection-management literals;
- exactly one `no-store` catalog fetch with abort/epoch protection; and
- absence of observation, provider, credential and periodic effects.

The B6a1 consumer gate now permits exactly
`app/providers-view.tsx`; `app/page.tsx` never imports the model directly.

## Acceptance results

```text
Focused B6a1+B6a2 unit: 18/18 PASS
Complete unit: 458/458 PASS
Runner suite in ambient user state: 476/477 PASS
Runner missing-enrollment scenario with clean private state-dir: 1/1 PASS
Migration suite: 39/39 PASS
Official integration programs: 11/11 PASS
TypeScript: PASS
Lint: ESLint + Oxlint PASS
Production build: PASS
Rendered HTML smoke: 2/2 PASS
git diff --check: PASS
```

The only ambient runner failure is outside this batch: the existing global
`~/.nexusos/runner` makes “engines report delivery requires an enrolled runner”
return the runner's safe local-error exit 78 instead of missing-enrollment exit
66. The same unchanged production command returns exit 66 against a new private
state directory. The global directory was not moved, cleaned or modified.

The final two integration programs initially could not open Wrangler state
under `~/Library/Preferences` in the managed sandbox. Both passed unchanged
with `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `WRANGLER_LOG_PATH` isolated under
`/tmp`.

## Exact scope

The six-path allowlist is:

- new `app/providers-view.tsx`;
- modified `app/page.tsx`;
- new `tests/unit/providers-view.test.ts`;
- modified `tests/unit/providers-view-model.test.ts`;
- this release evidence; and
- one Sprint 8 hunk in `docs/PROGRAM-PLAN.md`.

Net production change is below the 400-line small-batch ceiling in normal
format. Lockfiles, dependencies and every other production path are untouched.

## Visual evidence

The coordinator opened `http://127.0.0.1:3037/` in the in-app browser, navigated
from the workspace to **Provedores**, and observed:

- `providers-view[data-state="declared"]`;
- one Anthropic card and one OpenAI card;
- a rendered 64-character lowercase SHA-256;
- the visible `DECLARADO · NÃO VERIFICADO` disclosure; and
- no `Conectado`, `Saudável`, heartbeat or validity copy.

The corrected candidate was reloaded after the accessibility changes. The
in-app Browser SDK emitted and the coordinator visually inspected a 74,202-byte
screenshot. It was not persisted to the filesystem. The earlier
`/private/tmp` capture predates the corrections and is deliberately not cited
as evidence for this final candidate or added to the six-path commit allowlist.

## Review status

Claude Code session `f1412360-bd9d-48d9-a022-052d10acf6ef`, exact model
`claude-opus-5`, returned an initial `NO-GO`, P0=0 and P1=3. The batch then:

- keyed the live-region root so closed alert states are inserted, not mutated;
- restored retry focus after another unavailable outcome; and
- extracted the pure visible loader and drove supersession plus unmount through
  deferred responses instead of relying only on source-text assertions.

The same correction also added a declared-success live status, hid decorative
provider initials from assistive technology and removed repeated status/detail
copy. Final closure review session
`bddcfec7-f6da-4ecd-90a6-cdd96ed82bfa`, exact model `claude-opus-5`, returned
`GO`, P0=0 and P1=0.

## Lifecycle and rollback

B6a2 is one commit with no external state. Reverting it restores the demo and
returns B6a1 to a dark zero-consumer boundary. B6b remains a separate batch for
explicit, point-in-time CLI observation; it must not infer provider connection,
account, execution or quota.
