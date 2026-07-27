# S6.B4 CLI compatibility baseline

> Captured: 2026-07-26; refreshed for B4.2c on 2026-07-27
> Scope: read-only metadata/auth evidence only; no prompt executed

## Installed binaries

- Claude Code `2.1.219` from the local Codex/Claude integration cache under
  `Library/Application Support`, plus `2.1.220` from Homebrew
- unsupported Codex CLI `0.145.0` Homebrew npm wrapper, plus the only supported
  local Codex engine, native `0.146.0-alpha.3.1` from the app resources

## Claude Code flags observed in local help

Both supported Claude installations expose `--print`, `--safe-mode`,
`--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`,
`--permission-mode`, `--tools`, `--strict-mcp-config`, `--mcp-config`,
`--settings` and `--output-format`. It states that `--tools ""` disables all
built-in tools. OAuth authentication remains available in safe mode.

The B4 adapter baseline is the literal argv recorded in the ADR. The empty
settings and MCP values are adapter-owned literal `{}` argv entries, not files
or host configuration. `dontAsk` is accepted by this version, but its
permission semantics are not the security boundary: `--tools ""` is.

The complete local `--help` output is 16036 bytes for both 2.1.219 and 2.1.220
and lists every planned flag family above. The older local 2.1.63 and 2.1.117
installations omit `--safe-mode` and intentionally remain incompatible. The
production Node pipe, AF_UNIX and blocking FIFO transports each returned
exactly 8192 bytes from the Bun-based 2.1.219 binary with exit zero and no
overflow signal. A complete 2x2x2 isolation matrix ruled out inherited versus
literal environment, ignored stdin versus `/dev/null`, and detached versus
attached process groups. Two private, pre-established IPv4 loopback streams
then captured the complete 16036 bytes without writing provider output to
disk. The production dry-run now classifies the real 2.1.219 installation as
metadata-compatible, with `truncated:false`; simulated transport coverage is a
Linux merge gate and a live real-binary Linux capture remains a release gate.
The 16384-byte bound leaves 348 bytes above both exact pinned help captures.
That narrow margin is accepted only because the version allowlist is exact:
any output drift or version change fails closed and requires fresh evidence
before the allowlist can move.

An unknown flag followed by `--help` also exits zero. Consequently B4.2 may
use the complete bounded help-token matrix as metadata evidence, but must not
claim that a `--help` short-circuit proves the full argv. Its readiness is
limited to a safe binary, version-pinned metadata compatibility and a closed
auth-status result. B4.4b owns the first full argv/provider turn and must ask
for a benign file/shell tool action and prove no marker access and no emitted
tool record.
Claude documents that enterprise-managed policy may remain active in safe
mode. NexusOS therefore reports host readiness, not configuration attestation,
and fails the authenticated canary if managed policy changes observable tool
behavior.

## Codex flags and features observed locally

The native 0.146.0-alpha.3.1 `codex exec --help` exposes stdin prompt `-`,
`--strict-config`,
`--sandbox read-only`, `--ephemeral`, `--ignore-user-config`,
`--ignore-rules`, `--skip-git-repo-check`, `--color`, `--json`, `--disable`
and `--config`.

Both `codex features list` captures report these stable feature names:

- `apps`
- `goals`
- `hooks`
- `multi_agent`
- `remote_plugin`
- `shell_snapshot`
- `shell_tool`

The native 0.146.0-alpha.3.1 binary was checked under the adapter's exact
literal environment: version, 3681-byte help, 5976-byte feature list and
stderr auth status all satisfy the bounded parsers. The installed 0.145.0
entry point is a `#!/usr/bin/env node` wrapper; relocation alone cannot make it
ready because the literal PATH intentionally excludes its Node interpreter.
It is not in the supported-version allowlist. Operators must use the pinned
native binary; any future audited wrapper needs its own complete compatibility
evidence before admission. The current Codex manual documents `shell_tool` as
the stable default shell
feature and warns that read-only mode alone is not a sufficient secret
boundary. The B4 adapter therefore disables every feature above, web search,
user config and rules explicitly. B4.2 must fail closed if any required flag
or stable feature cannot be disabled.

## Privacy note

The installed read-only status commands are `claude auth status --json` and
`codex login status`. Claude 2.1.219 and 2.1.220 both returned an exact JSON
object with keys `apiProvider`, `authMethod`, `email`, `loggedIn`, `orgId`,
`orgName` and `subscriptionType`; readiness consumes only the boolean
`loggedIn` and immediately discards all raw values. Both engines returned a
closed auth result during the local capture; Codex may emit its supported
ready line on stderr, which the closed parser handles identically. A second
`codex login status` capture used an empty
temporary HOME, created no files, exited 1 and contained one exact closed
`Not logged in` line after a non-private warning. The adapter therefore
requires exit 0 plus an exact supported `Logged in using ...` line for ready,
and exit 1 plus the exact `Not logged in` line for attention; every other
combination is unknown. Vendor auth-status commands can return account email
and organization facts. The probe may map their result locally into `ready`,
`attention_required` or `unknown`, but must discard raw stdout/stderr before
building the signed inventory. No captured auth output belongs in QA evidence.
