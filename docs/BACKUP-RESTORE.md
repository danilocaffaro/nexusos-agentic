# Backup and restore Core Local

Core Local stores D1-compatible local state beneath the configured state
directory, `.wrangler/state` by default.

## Safety boundary

Back up only while NexusOS and its local runner are stopped. Copying SQLite
files while a writer is active can produce an inconsistent snapshot. A backup
may contain messages, artifacts, prompts, identities, and audit data; protect it
as sensitive user data.

## Offline backup

1. Stop the launcher with `Ctrl+C` and wait for shutdown.
2. Confirm no NexusOS or Wrangler process is using the chosen state directory.
3. Create an archive outside the source tree:

```bash
tar -C /path/to/nexusos -czf /secure/path/nexusos-state-backup.tgz \
  .wrangler/state
shasum -a 256 /secure/path/nexusos-state-backup.tgz
```

Store the checksum, release manifest, source commit, timestamp, platform, and
Node.js version with the backup. Restrict access using operating-system
permissions and encrypted storage appropriate to the data.

## Restore rehearsal

Never overwrite the only copy of current state during a rehearsal.

```bash
mkdir -p /secure/path/nexusos-restore-test
tar -C /secure/path/nexusos-restore-test \
  -xzf /secure/path/nexusos-state-backup.tgz
npm run local:ready -- \
  --state-dir /secure/path/nexusos-restore-test/.wrangler/state \
  --port 3902
```

Verify health and representative durable records, then stop the instance. A
backup is not accepted merely because the archive command succeeded.

## Recovery

Restore into a new empty directory, verify it on an isolated port, then point
the intended release at that restored directory. Preserve the failed state and
logs for diagnosis. Do not merge SQLite files or copy individual database
files between active state trees.

Hosted D1/Sites recovery is outside Core Local v1 and follows the provider's
private deployment runbook.
