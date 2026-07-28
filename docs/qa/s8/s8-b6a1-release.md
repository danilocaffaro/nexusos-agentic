# S8.B6a1 release evidence

## Discover and frame

S8.B6a1 tests one reversible hypothesis: NexusOS can establish a hostile-total
client boundary for the B5 provider catalog without adding a UI consumer or
promoting declared provider data into a connectivity claim.

The corrected architecture and split gate ran in Claude Code with exact model
`claude-fable-5`, session `221911c0-1250-4d3b-b876-b8eb5408e2b3`. It rejected
semantic weakening and minification, split the visible slice into B6a2 and
returned `GO`, P0=0 and P1=0. The implementation base is
`main@f31bd89576468eb2979656c8ff2c3850ee61eae3`, tree
`e560997293dda1dc2758cd81d987e1edcc7cacd6`.

## Delivered boundary

The only production addition is `app/providers-view-model.ts`. It provides:

- exact v1/source/projection/claim parsing with existing catalog bounds;
- fail-closed hostile-object, accessor, symbol, sparse-array and proxy handling;
- detached, deeply frozen provider/method/model projections;
- declared CLI candidate derivation with `declared_unverified` trust;
- exact catalog-to-header digest comparison;
- centralized Portuguese status/detail copy and positive-claim guards; and
- isolated catalog/options/observe abort-and-epoch request lanes.

The coordinator performs no transport. The parser performs no fetch. There is
no production consumer, and `app/page.tsx` is byte-identical to the base. The
prototype Providers demo remains unchanged until its atomic B6a2 replacement.

## Security and truth evidence

Focused tests freeze:

- exact keys, versions, bundled source, lowercase SHA-256 and declared-only
  claim;
- a frozen local wire manifest compared field-for-field with current server
  vocabulary, regex source/flags, engines and bounds;
- provider, method and model identities, relationships, engines and N/N+1
  limits, including exact maximum acceptance;
- invalid provider/model identifiers, empty/untrimmed/oversized/unsafe labels
  and invalid OAuth/CLI engine mutex claims;
- `declared_unverified` on every accepted method;
- data-descriptor-only reads with no accessor invocation;
- fail-closed sparse, symbol, extra-key and throwing-proxy cases;
- caller-detached and deeply frozen results;
- CLI-only candidate derivation;
- digest match, mismatch, malformed and absent-header behavior;
- status/chip absolute positive-claim rejection and explicitly negated detail
  allowance;
- lane isolation, supersession, stale completion rejection and abort-all; and
- a zero-consumer/effect gate across app, source, runner, worker and scripts
  roots, plus the untouched demo proof.

The projection vocabulary is deliberately local to the client anti-corruption
layer so the frozen four-consumer B1 production boundary remains unchanged.
The frozen manifest and accepted-at-N tests bind that vocabulary to current
server constants; contract drift therefore fails closed and requires a
deliberate parser update instead of silently widening the B1 consumer set.

No test claims that the existing demo is truthful. Its continued presence is
documented only to prove B6a1 has not partially changed the visible surface.

## Acceptance results

The final candidate records:

```text
Focused B6a1 unit: 12/12 PASS
Complete unit: 446/446 PASS
Runner unit/contract suite: 477/477 PASS
Migration suite: 39/39 PASS
TypeScript: PASS
Lint: ESLint + Oxlint PASS
Official integration programs: 11/11 programs PASS
Production build: PASS
Rendered HTML smoke: 2/2 PASS
git diff --check: PASS
Five-path allowlist and one PROGRAM-PLAN.md hunk: PASS
Claude Opus 5 implementation review: GO, P0=0, P1=0
```

The complete serial `npm test` gate passed TypeScript, all unit, runner,
migration and integration suites, production build and rendered smoke in one
process chain. Lint and the focused B6a1 suite were rerun separately. No
concurrent integration process contributed to these results.

## Exact scope

The five-path allowlist is:

- new `app/providers-view-model.ts`;
- new `tests/unit/providers-view-model.test.ts`;
- new `docs/adr/S8B6-truthful-provider-cli-ux.md`;
- this release evidence; and
- one Sprint 8 hunk in `docs/PROGRAM-PLAN.md`.

Dependencies, package scripts, lockfiles and all other source files are
untouched. There is no UI, route, fetch, timer, observer, OAuth, provider call,
CLI process, runner, credential, secret, schema, migration, persistence or CSS
change.

## Review status

Claude Code session `ae57fa52-dbf3-4b6f-9e4e-3b9d37ffafea`, exact model
`claude-opus-5`, returned an initial `NO-GO`, P0=0 and P1=4. The four findings
were closed in the same allowlist: exact N acceptance now detects bound
widening, a frozen manifest binds every local wire value, invalid identity and
label matrices cover the parser branches, and the zero-consumer/effect scan
includes app, source, runner, worker and scripts roots. After the corrected
full serial gate passed, the same session directly inspected the final tree and
returned `GO`, P0=0 and P1=0. Its P2 wording observation was incorporated by
narrowing the ADR manifest claim to server-facing contract constants.

## Lifecycle and rollback

B6a1 is one commit and has no external state. Revert removes the four new files
and restores the single Sprint 8 plan hunk. B6a2 must be promoted only after
this batch passes its independent guard.

B6a2 will remove the demo and mount the real catalog view in one atomic commit.
B6b remains separate and may consume the observation route only after its own
architecture and truth gate.
