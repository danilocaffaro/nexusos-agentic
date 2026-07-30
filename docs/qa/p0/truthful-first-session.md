# TRUTHFUL-FIRST-SESSION

Status: PASS

Base: `72f9c2aee9551ce12c88ca73c4b835f02c53445a`

Integration order: after `S8.B6a2`

## Release hypothesis

A user can open NexusOS and immediately reach the persistent project CRUD
without first crossing a simulated onboarding. The optional tour, Today and
Releases may remain useful end-state visioning only when they cannot be
mistaken for observed connectivity, execution, health, presence, PR or deploy
state.

## Truth boundary

| Surface | Authoritative in this batch | Explicitly illustrative |
| --- | --- | --- |
| First session | `project`, backed by `/api/workspace` | none |
| Onboarding | navigation back to the real workspace | all setup, members and integrations |
| Today | CTAs to persistent Projects and Inbox | briefing, portfolio and live operations |
| Releases | none until GitHub is connected | PRs, checks, deploys, versions and metrics |

The onboarding connection controls are disabled and labeled roadmap. It does
not mutate connection state or show success toasts. Today does not claim
uptime, event counts, online agents or session validity. Releases has no sync,
production, rollback or PR-opening effect and presents one dominant
`VISIONING · GITHUB NÃO CONECTADO` disclosure.

## Scope and composition

The exact file allowlist is:

- `app/page.tsx`;
- `tests/rendered-html.test.mjs`;
- `tests/unit/truthful-first-session.test.ts`;
- `docs/qa/p0/truthful-first-session.md`.

The original maximum allowlist was expanded by the integration coordinator
after the build exposed two stale smoke assertions that required the initial
SSR to contain the old onboarding copy. Only those assertions changed: the
render gate now requires `project-view`, the active Project navigation item
and `Projetos`, while rejecting both obsolete onboarding strings. Production
HTML was not polluted with hidden compatibility copy.

This candidate deliberately does not modify provider imports, the provider
catalog client, `ProvidersView` or its tests. Because `S8.B6a2` also changes
`app/page.tsx`, that batch integrates first. This candidate must then be
rebased or cherry-picked with the first-session, onboarding, Today and Releases
hunks preserved and the B6a2 provider hunk left authoritative.

## Verification

The focused source contract proves:

- the initial view is `project`;
- `Rever onboarding` still reaches the optional `welcome` tour;
- onboarding contains no connected, authenticated, healthy, valid or ready
  claim and its integration effects remain disabled;
- Today contains no fake uptime, event or online-agent count and its actionable
  CTAs route only to Projects or Inbox;
- Releases contains no fake sync, production health, deployed version or
  metrics and exposes no active external-effect button.

Release gates:

```text
npx tsx --test tests/unit/truthful-first-session.test.ts
npm run typecheck
npm run test:unit
npm run lint
npm run build
npm run test:smoke
git diff --check
```

Final candidate evidence:

- focused truth contract: 4/4;
- repository unit suite: 456/456;
- TypeScript typecheck: pass;
- ESLint and Oxlint: pass;
- production build: pass;
- rendered HTML and worker smoke: 2/2;
- diff hygiene: pass.

The import block, legacy provider-data section and complete legacy
`ProvidersView` section remain byte-identical to the base, with matching
SHA-256 hashes. They are intentionally left for `S8.B6a2` to replace before
this candidate is integrated.
