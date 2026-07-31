# Install NexusOS Core Local

## Supported boundary

Core Local v1 supports macOS and Linux with Git, npm and Node.js 22.19.0.
Windows is unsupported. No Cloudflare, GitHub, Jira, Slack, provider account or
paid service is required to start the local control plane.

Provider-backed operations are optional. When used, install and authenticate
Claude Code CLI or Codex CLI separately. NexusOS does not bundle, receive or
refresh that credential.

## From GitHub Release

Download from one release:

- `nexusos-core-local-VERSION-source.tgz`;
- `nexusos-core-local-VERSION.manifest.json`;
- `SHA256SUMS`;
- `bom.spdx.json` and `bom.cdx.json`.

Verify before extraction:

```bash
shasum -a 256 -c SHA256SUMS
gh attestation verify nexusos-core-local-VERSION-source.tgz \
  --repo danilocaffaro/nexusos-agentic
```

Install and start:

```bash
tar -xzf nexusos-core-local-VERSION-source.tgz
cd nexusos-core-local-VERSION
npm ci
npm run local:ready
```

Open the readiness URL printed by the launcher. The default is
`http://127.0.0.1:3002`; state is project-local at `.wrangler/state`.

The archive contains source, migrations and local runtime scripts. It excludes
dependencies, provider CLIs, credentials, user state, private hosting metadata,
tests and internal QA.

## From the repository

```bash
git clone https://github.com/danilocaffaro/nexusos-agentic.git
cd nexusos-agentic
npm ci
npm run local:ready
```

For a release install, prefer the exact release tag or checksummed archive over
an arbitrary branch head.

## Isolated evaluation

```bash
npm run local:ready -- --state-dir /tmp/nexusos-evaluation --port 3902
```

Stop with `Ctrl+C`. Read [BACKUP-RESTORE.md](BACKUP-RESTORE.md) before
upgrading valuable state.
