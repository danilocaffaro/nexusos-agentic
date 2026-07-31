# Release NexusOS Core Local

This maintainer runbook publishes the checksummed source distribution to
`danilocaffaro/nexusos-agentic` GitHub Releases.

## Release contract

- Product: NexusOS Core Local.
- Runtime: macOS and Linux; Windows unsupported in v1.
- License: Apache-2.0.
- Package metadata: `@danilocaffaro/nexusos`, kept `"private": true` because
  npm is not the distribution channel.
- Managed Sites/D1: optional private profile, outside the OSS v1 support
  boundary.

## Required artifacts

- deterministic `nexusos-core-local-VERSION-source.tgz`;
- external manifest with version, commit, schema and platform boundary;
- `SHA256SUMS`;
- CycloneDX and SPDX JSON SBOMs;
- GitHub build-provenance and SBOM attestations;
- changelog and release notes.

The archive is built from an exact source allowlist. It excludes local state,
credentials, private hosting metadata, tests, internal QA, build caches and
dependencies.

## Preflight

1. Resolve every P0/P1 and accepted security dissent.
2. Set `package.json` and changelog to the release version.
3. Verify backup/restore and migration evidence.
4. Require a clean commit and successful macOS/Linux CI.
5. Run:

```bash
npm ci
npm test
npm run lint
npm run audit:prod
npm run package:release
npm run release:checksums
(cd release && shasum -a 256 -c SHA256SUMS)
```

6. Package twice with the same commit-derived `SOURCE_DATE_EPOCH` and require
   byte-identical archives.
7. Extract the exact archive into a clean directory, run `npm ci`, build, start
   `scripts/usable-local.mjs`, complete onboarding and verify persisted restart.

## Tag and workflow

Create a tag exactly matching `v${package.version}` only after main CI is green.
Pushing the tag runs `.github/workflows/release.yml` on macOS and Linux,
generates the package/SBOMs/checksums once, validates the extracted archive,
attests the artifacts and publishes the GitHub Release.

Do not rebuild locally and upload substitutes. A failed workflow must create no
release.

## Rollback

Application rollback uses the previous checksummed artifact. Database rollback
uses a verified pre-upgrade backup restored to a separate path. Forward-only
migrations prohibit pointing old source at a newly migrated database.
