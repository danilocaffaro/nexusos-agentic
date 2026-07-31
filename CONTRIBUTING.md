# Contributing to NexusOS

NexusOS is pre-1.0 software. Keep changes small, evidence-backed, reversible,
and honest about capability state.

## Development environment

Supported contributor hosts are macOS and Linux with Git and Node.js 22.19.0.
Windows is not supported for v1 development or runtime verification.

```bash
git clone https://github.com/danilocaffaro/nexusos-agentic.git
cd nexusos-agentic
npm ci
npm test
```

Use an isolated branch or worktree. Do not commit `.env` files, `.wrangler`,
`.nexusos`, provider sessions, tokens, database state, or generated release
artifacts.

## Pull requests

1. State the user-visible outcome and the exact paths in scope.
2. Add hostile-input, replay, authorization, migration, or state-machine tests
   when the boundary requires them.
3. Run `npm test`, `npm run lint`, and `npm run audit:prod`.
4. For schema changes, run `npm run db:generate`, review the SQL, and prove
   clean install plus upgrade behavior.
5. For release changes, run `npm run test:release` and package from a clean
   committed tree with `npm run package:release`.
6. Record residual risks. Do not label simulated or roadmap behavior as real.

Contributions intentionally submitted for inclusion are licensed under
Apache-2.0 as described in [LICENSE](LICENSE). No contributor license agreement
or paid GitHub feature is required.

Security reports follow [SECURITY.md](SECURITY.md), never a public issue.
