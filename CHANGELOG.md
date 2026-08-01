# Changelog

All notable public release changes are recorded here. The project follows Keep
a Changelog and Semantic Versioning.

## [1.1.5] - 2026-07-31

### Fixed

- Keep the safe-restart acceptance focused on one handled shutdown signal and
  persisted recovery, leaving the bounded second-signal escalation as a
  separate launcher contract instead of racing a process already in teardown.

## [1.1.4] - 2026-07-31

### Fixed

- Accept the safe shutdown race where the server finishes gracefully before a
  second signal can force it, while still requiring the launcher itself to
  exit through its handler with code 143 instead of dying by `SIGTERM`.

## [1.1.3] - 2026-07-31

### Fixed

- Emit the graceful-shutdown acknowledgement only after the first signal
  handler returns, so an immediate second signal reliably takes the bounded
  escalation path on macOS.

## [1.1.2] - 2026-07-31

### Fixed

- Make the macOS release shutdown acceptance deterministic by waiting for the
  first graceful-shutdown acknowledgement before exercising the documented
  second-signal escalation path.

## [1.1.1] - 2026-07-31

### Fixed

- Store the LaunchAgent tunnel key under the private NexusOS Application
  Support directory so macOS background privacy controls do not break the
  persistent reverse SSH tunnel.
- Align remote activation and login on a user-selected minimum password length
  of 8 characters, enforced by both the browser and server boundary.

### Security

- Tunnel keys remain mode `0600`; an existing service key must match the
  prepared key and cannot be silently replaced during reinstall.
- Password hashing remains salted PBKDF2-HMAC-SHA256 with 600,000 iterations,
  login throttling and server-side session revocation.

## [1.1.0] - 2026-07-31

### Added

- Opt-in secure remote profile with first-owner activation, password login,
  revocable sessions, throttling and same-origin mutation enforcement.
- Authenticated message file exchange with local private object storage,
  membership authorization and one-way message binding.
- Mac LaunchAgents for the production runtime and outbound reverse SSH tunnel.
- Oracle/Caddy gateway automation with a dedicated restricted tunnel identity
  and both direct-TLS and optional Cloudflare Tunnel modes.

### Security

- The app and gateway forwarding listener remain loopback-only; the Mac opens
  the SSH tunnel outward.
- Passwords use salted PBKDF2-HMAC-SHA256 at 600,000 iterations; plaintext
  activation and session tokens are never persisted.
- Remote cookies are Secure, HttpOnly, SameSite=Strict and `__Host-` scoped.
- File types, size and content signatures are bounded, and downloads are forced
  with sandbox/no-sniff headers.

### Known limits

- Remote identity is single-owner and has no first-party MFA or password
  recovery in v1.1.
- Files are reported as `not_scanned`; antivirus scanning is not included.
- Oracle, Caddy, a domain and the optional Cloudflare edge remain operator-owned
  infrastructure and are not required by Core Local.

## [1.0.0] - 2026-07-30

### Added

- Empty first-run onboarding for workspace, owner, project and team.
- Persistent CRUD for the core work graph and hybrid agent assignments.
- Persistent DMs, rooms, messages, presence, attention and artifact lifecycle.
- Governed ActionIntents, approvals, evidence and Decision Packages.
- Signed local runner enrollment, liveness, admission and Claude/Codex CLI
  execution.
- Owner-only operational loop from work item and agent model to confirmed
  output, Markdown artifact and ledger event.
- Deterministic source release with manifest, checksums, SBOMs and GitHub
  attestations.

### Security

- Release allowlist excludes local state, credentials, private hosting metadata
  and internal QA.
- Contextual prompts and output excerpts are bounded; malformed, unavailable or
  truncated output cannot be published.
- Ledger entries and approvals are append-only at the application schema level.
- Operations freeze project/work item/agent/model/runner bindings and use
  idempotent creation/publication contracts.

### Known limits

- Local single-owner loopback identity only.
- macOS and Linux supported; Windows unsupported.
- Direct OAuth, audio/video, sandbox attestation, streaming and autonomous
  tool/MCP execution are not part of v1.0.
