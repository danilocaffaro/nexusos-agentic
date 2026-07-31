# Install NexusOS Core Local

## Supported boundary

Core Local supports macOS and Linux with Git, a POSIX shell, and Node.js
22.19.0. Windows is explicitly unsupported in v1. No Cloudflare, GitHub, Jira,
Slack, model-provider account, or paid service is required to start the local
control plane.

Provider-backed execution is optional. If used, install and authenticate the
supported provider CLI separately; NexusOS never bundles that credential.

## From source

Until a GitHub Release exists, clone the provisional repository:

```bash
git clone https://github.com/danilocaffaro/nexusos-agentic.git
cd nexusos-agentic
npm ci
npm run local:ready
```

Open the readiness URL printed by the launcher. The default is
`http://127.0.0.1:3002`. The default state is project-local at
`.wrangler/state`.

## From a future GitHub Release

Download these files from the same release:

- `nexusos-core-local-VERSION-source.tgz`
- `nexusos-core-local-VERSION.manifest.json`
- `SHA256SUMS`
- the SPDX or CycloneDX SBOM

Verify checksums before extraction:

```bash
shasum -a 256 -c SHA256SUMS
tar -xzf nexusos-core-local-VERSION-source.tgz
cd nexusos-core-local-VERSION
npm ci
npm run local:ready
```

Also verify the GitHub artifact attestation when one is published:

```bash
gh attestation verify nexusos-core-local-VERSION-source.tgz \
  --repo danilocaffaro/nexusos-agentic
```

Release archives contain source, migrations, and local runtime scripts. They do
not contain dependencies, provider CLIs, credentials, user state, private Sites
metadata, or an authenticated hosted service.

## Isolated state

Use a separate state directory for evaluation or concurrent instances:

```bash
npm run local:ready -- --state-dir /tmp/nexusos-evaluation --port 3902
```

See [BACKUP-RESTORE.md](BACKUP-RESTORE.md) before upgrading valuable state.
