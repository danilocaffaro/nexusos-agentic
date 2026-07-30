# P0 — Usable local release

## Outcome

One command starts the local NexusOS control plane at the canonical URL
`http://127.0.0.1:3002`, applies D1 migrations to project-local state, and
does not declare readiness until the database, workspace read model, and
runner audience agree on the same runtime.

```bash
npm run local:ready
```

The default durable state is `.wrangler/state`. An isolated caller can provide
`--state-dir PATH` without reading or mutating that default:

```bash
npm run local:ready -- --state-dir /path/to/isolated-state --port 3902
```

## Safety and truth boundary

- Vinext binds only to `127.0.0.1` and receives `--hostname` explicitly.
- `WRANGLER_LOG_PATH`, Miniflare registry, and D1 state are never allowed to
  fall back to a user-global location.
- `NEXUS_RUNNER_AUDIENCE` is set to the exact URL printed by the launcher.
- Readiness fails closed unless `/api/system/health` reports `ok/ready`,
  `/api/workspace` satisfies the persisted read model, and `/api/runners`
  returns that exact audience.
- `SIGINT` and `SIGTERM` are forwarded to the complete child process group,
  with a bounded forced-stop fallback.
- The acceptance flow declares an A0 agent with an unconnected model and never
  invokes a run, provider session, terminal, or LLM.
- GitHub PR/deployment cards, the illustrative onboarding, and the simulated
  ledger timeline are not made real by this release.

## Acceptance evidence

`tests/usability-core.integration.mjs` creates an isolated temporary D1 state
and performs one ordered journey:

1. project;
2. team;
3. unconnected A0 agent;
4. direct conversation and persisted message;
5. objective/work-item anchor and Markdown artifact versions 1 and 2;
6. idempotent ActionIntent and verified ledger entry;
7. safe shutdown and restart on the same temporary state;
8. re-read of every created identity, message, artifact content, intent, and
   ledger entry;
9. exact runner-audience verification after restart.

The temporary state is always removed in `finally`; the user's
`.wrangler/state` is never part of the test.

## Verification

The release is accepted only when the focused usability integration,
typecheck, lint, the complete unit suite, build, smoke test, and production
dependency audit pass on the committed tree. Exact counts and commit/tree
identities are recorded in the release handoff rather than hard-coded here.
