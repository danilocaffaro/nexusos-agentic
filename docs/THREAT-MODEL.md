# NexusOS v1 threat model

## Scope

This model covers one owner running NexusOS on a trusted macOS or Linux host.
Core Local and Remote Access both bind the application to loopback. Remote
Access adds an authenticated browser boundary, an HTTPS gateway and a
Mac-initiated reverse SSH tunnel. Multi-user RBAC, Windows, external connectors
and autonomous workspace mutation remain outside the v1 boundary.

## Protected assets

- local D1 state, including collaboration, governance, artifacts, and ledger;
- runner private key, enrollment state, durable outbox, and attempt journal;
- encrypted prompts and excerpts plus their keyring;
- owner password verifier, session hashes, private message files and tunnel key;
- provider CLI session owned by the provider;
- release source, manifest, checksums, SBOM, and provenance.

## Trust boundaries

1. Browser to loopback or public HTTPS control-plane boundary.
2. HTTPS gateway to a loopback-only reverse SSH listener.
3. Mac-initiated SSH tunnel to the loopback application.
4. Control plane to local D1/Workerd and object state.
5. Signed runner HTTP protocol to the control plane.
6. Runner to an explicitly selected, canonical provider executable.
7. Maintainer CI to GitHub Release and artifact attestation services.

GitHub Releases is the distribution channel, not runtime authority. Cloudflare
Sites and hosted D1 are optional private integrations and are not trusted by
Core Local v1.

## Threats and controls

- **Malicious archive:** checksums, exact manifest commit, SBOM, and GitHub
  attestation bind the downloaded source to the release workflow.
- **Secret inclusion:** a closed source allowlist excludes `.env*` except the
  empty example, `.nexusos`, `.wrangler`, `.openai`, tests, and internal QA.
- **Remote account takeover:** one-time random activation; salted PBKDF2
  password verification; login throttling; opaque, expiring, revocable,
  server-side sessions; Secure/HttpOnly/SameSite cookies.
- **Cross-site requests and host confusion:** configured HTTPS origin, public
  host allowlist, Origin and browser fetch-site validation on mutations.
- **Gateway or tunnel abuse:** app and gateway forward bind to loopback;
  dedicated non-login SSH identity; `GatewayPorts no`; authorized key restricted
  to one reverse listen address and port.
- **Malicious upload:** filename/type allowlist, byte limit, magic-byte checks,
  opaque object key, membership authorization and forced download. Malware
  scanning is not claimed.
- **Runner impersonation/replay:** enrollment uses one-time tokens and signed,
  nonce-bound requests with durable replay records.
- **Executable substitution:** the runner canonicalizes an absolute provider
  CLI path and records host evidence before eligibility.
- **Prompt disclosure:** non-local execution requires a bounded AES-GCM
  keyring; local fallback keys are development-only.
- **Migration corruption:** migrations run before readiness; hosted private
  mode attests final trigger bodies. Offline backups precede valuable upgrades.
- **Audit tampering:** ledger entries form a hash chain. Storage triggers deny
  update, delete and replace of ledger entries/approvals and restrict intent
  lifecycle transitions. A local database administrator can still remove
  triggers or forge new inserts and remains inside the trusted-host boundary.

## Accepted v1 risks

- local host administrators can read or modify local files and process memory;
- Remote Access has one human owner and no first-party MFA, password recovery
  or delegated multi-user administration;
- an attacker controlling the trusted Mac administrator account can read
  application state, object data, runtime memory and tunnel credentials;
- the gateway and optional Cloudflare edge can observe connection metadata and
  availability, while HTTPS terminates before Caddy in Cloudflare mode;
- file malware is not detected by the core `not_scanned` pipeline;
- provider CLI isolation is host-reported, not a universal sandbox guarantee;
- no availability, disaster-recovery, or support SLA exists;
- Sites authentication and D1 recovery are outside the OSS release.

External anchoring, WORM storage, multi-user identity, first-party MFA,
hostile-host protection and malware scanning require a later deployment
profile and are not claimed by v1.1.
