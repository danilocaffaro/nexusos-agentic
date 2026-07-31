# Release NexusOS Core Local

This is a maintainer runbook. It prepares GitHub Releases as the future public
channel; it does not authorize publishing the current 0.1.0 private package as
v1.0.

## Release contract

- Product: NexusOS Core Local.
- Supported runtime: macOS and Linux.
- Unsupported in v1: Windows.
- Channel: provisional `danilocaffaro/nexusos-agentic` GitHub Releases.
- License: Apache-2.0.
- Managed Sites/D1 deployment: optional private profile, outside the OSS v1
  support boundary.
- npm name: provisional `@danilocaffaro/nexusos`; npm publication remains
  disabled by `"private": true`.

## Required artifacts

- deterministic `nexusos-core-local-VERSION-source.tgz`;
- external release manifest containing version, source commit, schema version,
  migration head, source epoch, and supported platforms;
- `SHA256SUMS`;
- CycloneDX and SPDX JSON SBOMs;
- GitHub build-provenance and SBOM attestations;
- changelog and release notes.

The source archive is an allowlisted build input, not a copy of the worktree.
It excludes `.openai/hosting.json`, `.env*` except `.env.example`, local state,
credentials, tests, internal QA, build caches, and dependencies.

## Preflight

1. Resolve every P0/P1 and accepted security dissent.
2. Set `package.json` to the intended version without changing `private` unless
   npm publication is separately approved.
3. Update `CHANGELOG.md`, supported versions, migration/restore evidence, and
   release notes.
4. Require a clean commit and successful macOS/Linux CI.
5. Run:

```bash
npm ci
npm test
npm run lint
npm run audit:prod
npm run package:release
npm run release:checksums
shasum -a 256 -c release/SHA256SUMS
```

6. Package independently a second time from another clean clone using the same
   commit-derived `SOURCE_DATE_EPOCH`; require byte-identical archives.
7. Extract the exact archive, run `npm ci` and `npm run build`, then exercise
   the public `scripts/usable-local.mjs` launcher and its health endpoint from
   the extracted tree. Internal `tests/` are deliberately not shipped.

## Tag and workflow

Only after approval, create a protected tag exactly matching
`v${package.version}`. Pushing that tag activates
`.github/workflows/release.yml`, which revalidates both platforms, builds once,
generates SBOMs/checksums, tests the extracted artifact, attests it, and creates
the GitHub Release.

Do not rebuild locally and upload substitute files. Promotion uses the exact
checksummed workflow artifact. A failed job creates no GitHub Release.

## Rollback

Application rollback uses the prior checksummed and attested artifact. Database
rollback uses a verified pre-upgrade backup restored to a separate path.
Forward-only migrations prohibit pointing old source at a newly migrated
database.
