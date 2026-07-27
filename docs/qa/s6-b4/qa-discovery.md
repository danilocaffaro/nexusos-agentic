# S6.B4 QA discovery

## Product promise under test

One owner/admin can send a bounded prompt to one explicitly selected local
runner and receive an auditable, bounded result from Claude Code or Codex.
Provider credentials remain on that host. The same system continues to work as
a collaboration/governance OS when no engine is installed.

## Highest-risk failures

1. A raw prompt or model output reaches ledger, event metadata, logs, metrics,
   semantic-operation storage or signed-request nonce replay.
2. A lost response, process crash or runner restart spawns the CLI twice.
3. A stale or revoked runner fetches a prompt or completes a superseded lease.
4. Shell interpolation, PATH lookup, inherited environment or arbitrary argv
   leaks credentials or enables command injection.
5. Claude and Codex adapters diverge from the common engine contract.
6. The UI calls execution sandboxed, verified or safe when only operator trust
   exists.
7. Engine availability becomes a hard dependency for projects, teams,
   collaboration or diagnostics.
8. A prompt assigned to one engine/runner silently falls back to another.
9. Existing diagnostic claim/completion bytes change.
10. Output overflow, invalid UTF-8, timeout or cancellation hangs the runner or
    creates unbounded storage.
11. A parent crash leaves a provider CLI orphan running while NexusOS publishes
    a false interrupted receipt.
12. Product copy hides that a run can consume the operator's paid provider
    quota.
13. A downgraded diagnostic runner claims or completes an engine row through a
    legacy route.
14. Deadline rejection leaves a run permanently non-terminal or attributes a
    system transition to a human/runner that did not perform it.

## Test layers

- pure contract/parser and golden-byte unit tests;
- fake-engine application-service tests;
- runner filesystem/process tests with fake executables;
- D1 migration, trigger, tenant and signed API integration;
- real local Claude Code/Codex acceptance when installed and authenticated;
- crash, disconnect, replay, cancel and stale-fence fault injection;
- browser truth, keyboard, screen-reader and responsive evidence;
- secret/path/prompt prohibited-output scan;
- Opus implementation review with zero P0/P1 at release.

## Non-goals

No test may claim B4 proves OS isolation, remote attestation, safe arbitrary
tools, streaming, multi-turn state or exactly-once effects after an
unobservable external process boundary. The accepted property is at-most-one
spawn per durable local attempt journal.
