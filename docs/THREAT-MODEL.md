# Core Local threat model

## Scope

This model covers one user running NexusOS Core Local on a trusted macOS or
Linux host. The web listener binds to loopback. Private Sites deployment,
multi-user hosted identity, Windows, external connectors, and autonomous
workspace mutation are outside the v1 boundary.

## Protected assets

- local D1 state, including collaboration, governance, artifacts, and ledger;
- runner private key, enrollment state, durable outbox, and attempt journal;
- encrypted prompts and excerpts plus their keyring;
- provider CLI session owned by the provider;
- release source, manifest, checksums, SBOM, and provenance.

## Trust boundaries

1. Browser to loopback control plane.
2. Control plane to local D1/Workerd state.
3. Signed runner HTTP protocol to the control plane.
4. Runner to an explicitly selected, canonical provider executable.
5. Maintainer CI to GitHub Release and artifact attestation services.

GitHub Releases is the distribution channel, not runtime authority. Cloudflare
Sites and hosted D1 are optional private integrations and are not trusted by
Core Local v1.

## Threats and controls

- **Malicious archive:** checksums, exact manifest commit, SBOM, and GitHub
  attestation bind the downloaded source to the release workflow.
- **Secret inclusion:** a closed source allowlist excludes `.env*` except the
  empty example, `.nexusos`, `.wrangler`, `.openai`, tests, and internal QA.
- **Remote access:** the local identity is accepted only for loopback origins.
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

## Accepted v1.0 risks

- local host administrators can read or modify local files and process memory;
- Core Local has one fixed human owner and no separate browser login;
- provider CLI isolation is host-reported, not a universal sandbox guarantee;
- no availability, disaster-recovery, or support SLA exists;
- Sites authentication and D1 recovery are outside the OSS release.

External anchoring, WORM storage, multi-user identity and hostile-host
protection require a different deployment profile and are not claimed by Core
Local v1.
