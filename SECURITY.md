# Security policy

## Supported versions

Security fixes are made on the latest v1.x GitHub Release and the current
development line. Older releases, private Sites previews and modified
third-party builds receive no support commitment.

NexusOS supports current macOS and Linux releases on Node.js
22.19.0. Windows is not supported in v1. Provider CLIs and hosted deployment
profiles have their own security boundaries.

## Report a vulnerability

Do not open a public issue for a vulnerability or suspected secret exposure.
Use GitHub private vulnerability reporting:

https://github.com/danilocaffaro/nexusos-agentic/security/advisories/new

Include the affected commit or release, platform, impact, minimal reproduction,
and whether the report contains live credentials. Never attach live tokens,
private keys, prompts, database snapshots, or personal data.

The project will acknowledge a valid private report when maintainer capacity
allows, coordinate remediation privately, and disclose only after a fix or
explicit risk decision. No response-time SLA is offered.

## Security boundaries

- Core Local binds to loopback and uses one fixed local owner.
- Remote Access also binds the app to loopback. Only an outbound SSH reverse
  tunnel reaches a dedicated loopback listener on the gateway.
- Remote activation requires a random one-time token. Passwords use
  PBKDF2-HMAC-SHA256 at 600,000 iterations; browser sessions are random,
  server-side, expiring and revocable. Cookies are Secure, HttpOnly,
  SameSite=Strict and use the `__Host-` prefix.
- State-changing remote requests require a same-origin browser context.
- Files are allowlisted, size-limited, content-sniffed and served as
  `application/octet-stream` with `nosniff` and a sandbox CSP. They are not
  claimed virus-clean unless an external scanner marks them clean.
- Authenticated CLI credentials remain owned by the CLI and are never bundled.
- Enrollment tokens must enter through the hidden prompt or deliberate stdin.
- `.wrangler`, `.nexusos`, `.env*`, Sites metadata, and release credentials
  must never appear in public artifacts.
- Ledger, intent approvals and decision definitions are protected against
  update/delete/replace by database triggers; an administrator of the local
  files remains inside the trusted-host boundary.
- A public source release is not an attestation that an external model,
  connector, sandbox or hosted identity is available.

See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for the current threat model.
