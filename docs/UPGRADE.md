# Upgrade NexusOS Core Local

NexusOS migrations are forward-only. Downgrading application source does not
downgrade the database.

## Before upgrading

1. Read `CHANGELOG.md` and the target GitHub Release notes.
2. Stop NexusOS and any enrolled local runner cleanly.
3. Create and verify an offline state backup using
   [BACKUP-RESTORE.md](BACKUP-RESTORE.md).
4. Record the current release manifest, commit, Node.js version, state path, and
   runner audience.
5. Verify the new archive checksum and GitHub attestation.

## Rehearse with a copy

Extract the new release into a new directory and restore a copy of the state to
an isolated path. Then run:

```bash
npm ci
npm run local:ready -- --state-dir /path/to/rehearsal-state --port 3902
```

Confirm health, workspace contents, projects, teams, agents, messages,
artifacts, ActionIntents, ledger history, and runners. Stop the rehearsal
instance before continuing.

## Apply

Start the new release against the original stopped state path. The launcher
applies pending D1 migrations before announcing readiness. Never interrupt an
active migration intentionally.

If readiness fails, preserve logs and state. Do not run an older release against
the migrated database. Restore the pre-upgrade backup into a different path and
restart the prior release there.

The v1.0 release establishes the baseline schema. Every later stable release
must add an automated previous-release fixture and measured restore evidence
before publication.
