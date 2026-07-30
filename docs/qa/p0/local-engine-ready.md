# LOCAL-ENGINE-READY

## Outcome

`npm run local:engine` composes the existing runner instead of creating a
second execution motor. It enrolls only through the established one-time-token
ceremony, pins one exact local provider CLI path, probes version/features/auth,
publishes the privacy-safe engine inventory and then starts the existing
heartbeat/recovery serve loop. An optional `--run` activates exactly one
already-created, already-assigned one-shot.

## Security and truth boundary

- state and Ed25519 identity stay in ignored
  `.nexusos/local-runner` with directory mode `0700`;
- there is no fallback to global `~/.nexusos`;
- enrollment token is accepted only by the existing hidden prompt or explicit
  `--token-stdin`; token, key and prompt never enter argv or wrapper output;
- the wrapper never issues a token, creates a run, submits a prompt, approves
  an ActionIntent or discovers ambient work;
- readiness is fail-closed on the runner's exact binary ownership, version,
  feature and provider-auth probes;
- provider credentials remain in the authenticated Claude Code/Codex CLI;
- tools, MCPs, workspace mutation, streaming and OS sandbox claims remain out
  of scope.

## Acceptance

`tests/local-engine-ready.integration.mjs` runs the wrapper as a real child
process against a bounded runner seam and proves:

1. exact phase order through enrollment, engine probe/report and serve;
2. no token in argv/stdout/stderr;
3. project-local `0700` state and no global state creation;
4. explicit run-only wiring with no ambient claim;
5. authentication attention stops before server publication or serve;
6. a secret-like unsupported argument is rejected without reflection;
7. a symlinked private root is rejected without changing its target.

Before promotion run the focused integration, runner suite, typecheck, lint,
build and the complete merged-tree pipeline.

## Candidate evidence — 2026-07-30

- focused wrapper integration: 4/4;
- inherited runner suite: 478/478;
- unit and migration suites: pass;
- build and rendered smoke: 2/2;
- typecheck, ESLint, Oxlint and `git diff --check`: pass;
- production dependency audit: zero high-severity vulnerabilities;
- ephemeral live probe of the exact installed Claude Code CLI:
  `2.1.219 (Claude Code)`, `available/ready`, auth positive. The probe directory
  was removed afterwards and this observation can drift before user execution.

A Claude CLI architecture-only pass returned `GO` for the composition boundary
with the explicit caveat that it did not inspect source. It is recorded as a
second design opinion, not as an independent code-review promotion gate.

The complete inherited `npm test` is not green on base `2e2db9c`: the
pre-existing `tests/runs-api.integration.mjs` deterministically observes 25
unrelated prior `run_events` during its reconcile-race global-delta assertion
(`exerciseEngineCreationReconcileRace`, expected zero). This batch does not
touch that test, run storage, scheduler or API. The failure reproduced with the
wrapper test absent and with a project-local Wrangler log, so it remains an
explicit inherited merged-tree blocker rather than being misreported as a pass.
