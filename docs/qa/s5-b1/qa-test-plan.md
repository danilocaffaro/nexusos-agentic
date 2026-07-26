# S5.B1 QA test plan

## Domain and contract gates

- Accept non-empty `text/markdown` up to 256 KiB by exact UTF-8 byte length.
- Reject unsupported media types, empty content, oversized title/note/body and
  invalid expected versions.
- Produce SHA-256 and byte count from server-observed content.

## Persistence and API gates

- Create payload, artifact, version 1 and current-version advance atomically.
- Append only the next version with compare-and-swap.
- Reject a stale expected version with `409`.
- Return not-found across tenants and for unrelated work-item identifiers.
- Reject invalid payload references, metadata, inactive producers, version
  gaps, mutation and deletion at the database boundary.
- Recompute content hash and byte count before returning a version.

## Browser gates

- Create and inspect a durable output from a real work item.
- Append a version and see current metadata, history and literal content update.
- Keep an editor open while a second writer appends, then surface a recoverable
  conflict without data loss.
- Navigate from Work Graph to Outputs and open an exact artifact deep link.
- Show no fixture artifact count or synthetic lineage.
- Fit a 390x844 viewport without horizontal overflow.

## Regression gates

- TypeScript, unit, migrations and all integrations.
- Production build and rendered HTML smoke.
- ESLint and production dependency audit.
