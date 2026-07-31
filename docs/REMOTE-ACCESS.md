# Secure Remote Access v1.1

## Outcome and boundary

This profile makes one Mac-hosted NexusOS instance reachable through an
authenticated HTTPS URL. The app, D1/SQLite files, uploaded objects and provider
CLI sessions remain on the Mac. The Mac opens the connection outward; neither
the Mac router nor the Mac firewall needs an inbound NexusOS port.

The v1.1 identity boundary is one owner account. Do not treat it as multi-user
RBAC. Do not reuse the NexusOS password, activation token or tunnel key for any
other service.

## Prerequisites

- a normal NexusOS install with `npm ci`;
- a DNS hostname;
- a Linux gateway reachable by SSH;
- Caddy on the gateway;
- either public TCP 80/443 for direct Caddy TLS or an existing Cloudflare
  Tunnel that sends the hostname to Caddy on port 80.

Cloudflare is optional. The open-source core uses only Caddy and OpenSSH.

## 1. Initialize the Mac

```bash
npm run remote:init -- --origin https://nexusos.example.com
npm run remote:service -- prepare
```

The first command writes `.nexusos/remote.env` with mode `0600`, stores only the
SHA-256 hash of a random activation token and prints the plaintext token once.
The second command creates a dedicated Ed25519 tunnel key and prints only its
public key.

Back up the activation token in a password manager before continuing. Never
paste `.nexusos/remote.env` or the private key into a ticket, chat or GitHub.

## 2. Provision the Oracle gateway

Copy this repository's `ops/remote` directory to the gateway. From an
administrative shell on the gateway:

```bash
sudo NEXUS_TUNNEL_PUBLIC_KEY='ssh-ed25519 PUBLIC_KEY_FROM_STEP_1' \
  sh ./ops/remote/install-oracle-gateway.sh \
  nexusos.example.com cloudflare
```

Use `direct` instead of `cloudflare` when Caddy receives public 80/443 itself.
The installer:

- creates the non-login `nexusos-tunnel` system account;
- restricts its key to remote forwarding on `127.0.0.1:3410`;
- leaves `GatewayPorts no`;
- validates both `sshd` and Caddy before reload;
- keeps a timestamped Caddy backup.

Cloudflare mode inserts the NexusOS route inside the existing `:80` site and
forces the original HTTPS scheme toward the app. Direct mode lets Caddy manage
the certificate automatically.

## 3. Install persistent Mac services

Use the gateway IP or an SSH-only hostname, not the Cloudflare HTTP hostname:

```bash
npm run remote:service -- install \
  --ssh-target nexusos-tunnel@203.0.113.10 \
  --state-dir /absolute/path/to/existing/.wrangler/state
npm run remote:service -- status
```

Two macOS LaunchAgents are installed:

- `com.nexusos.remote.app` builds, migrates and starts the production Workerd
  runtime on `127.0.0.1:3003`;
- `com.nexusos.remote.tunnel` maintains the reverse SSH tunnel with strict host
  key checking, keepalives and fail-closed forwarding.

Logs are under `.nexusos/logs`. The application is not announced ready until
migrations, health, remote-auth mode and anonymous-route denial all pass.

## 4. Activate the owner

Open the HTTPS URL. On the first visit, enter:

- the one-time activation token;
- owner display name;
- a unique login;
- a new password of at least 14 characters.

Activation creates the credential and session, invalidates reuse of the token
at the application layer and opens normal first-use onboarding. Later visits
use the login page. Logout revokes the server-side session immediately.

## File exchange

Messages may attach up to three files, 25 MB each. Supported types are plain
text, Markdown, CSV, JSON, PDF, PNG, JPEG, GIF, WebP, ZIP, DOCX, XLSX and PPTX.
HTML, JavaScript and SVG are rejected. Downloads are forced rather than rendered
inline.

The built-in profile does not include antivirus. The UI and API report
`not_scanned`; add a ClamAV quarantine workflow before accepting files from
untrusted people.

## Operations and recovery

Check the Mac:

```bash
npm run remote:service -- status
tail -f .nexusos/logs/app.error.log
tail -f .nexusos/logs/tunnel.error.log
```

Check the gateway:

```bash
sudo ss -ltnp | grep 3410
sudo journalctl -u caddy --since '15 minutes ago'
curl -i http://127.0.0.1:3410/api/auth/status \
  -H 'Host: nexusos.example.com'
```

A missing tunnel must produce a gateway error; never redirect the hostname to
an unauthenticated fallback. If the tunnel private key is exposed, remove its
authorized-key line on the gateway, run `remote:service -- prepare` after
moving the old key aside, install the new public key, and then restart the
LaunchAgent.

Remote credential recovery is intentionally not automated in v1.1. Preserve an
offline backup, stop public routing and follow a reviewed recovery procedure
instead of deleting authentication rows by hand.
