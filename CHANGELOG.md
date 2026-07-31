# Changelog

All notable public release changes are recorded here. The project follows Keep
a Changelog and Semantic Versioning.

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
