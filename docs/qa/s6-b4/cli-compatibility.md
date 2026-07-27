# S6.B4 CLI compatibility baseline

> Captured: 2026-07-26
> Scope: architecture evidence only; no engine process executed

## Installed binaries

- Claude Code `2.1.219`
- Codex CLI `0.145.0`

## Claude Code flags observed in local help

The installed CLI exposes `--print`, `--safe-mode`,
`--disable-slash-commands`, `--no-chrome`, `--no-session-persistence`,
`--permission-mode`, `--tools`, `--strict-mcp-config`, `--mcp-config`,
`--settings` and `--output-format`. It states that `--tools ""` disables all
built-in tools. OAuth authentication remains available in safe mode.

The B4 adapter baseline is the literal argv recorded in the ADR. The empty
settings and MCP values are adapter-owned literal `{}` argv entries, not files
or host configuration. `dontAsk` is accepted by this version, but its
permission semantics are not the security boundary: `--tools ""` is.

The complete local `--help` output is 16036 bytes and lists every planned flag
family above. An earlier synchronous capture returned only 8192 bytes without
surfacing overflow and was rejected as evidence. More importantly, an unknown
flag followed by `--help` also exits zero. Consequently B4.2 may use the
complete bounded help-token matrix as metadata evidence, but must not claim
that a `--help` short-circuit proves the full argv. Its readiness is limited
to a safe binary, version-pinned metadata compatibility and a closed
auth-status result. B4.4b owns the first full argv/provider turn and must ask
for a benign file/shell tool action and prove no marker access and no emitted
tool record.
Claude documents that enterprise-managed policy may remain active in safe
mode. NexusOS therefore reports host readiness, not configuration attestation,
and fails the authenticated canary if managed policy changes observable tool
behavior.

## Codex flags and features observed locally

`codex exec --help` exposes stdin prompt `-`, `--strict-config`,
`--sandbox read-only`, `--ephemeral`, `--ignore-user-config`,
`--ignore-rules`, `--skip-git-repo-check`, `--color`, `--json`, `--disable`
and `--config`.

`codex features list` reports these stable enabled features:

- `apps`
- `goals`
- `hooks`
- `multi_agent`
- `remote_plugin`
- `shell_snapshot`
- `shell_tool`

The current Codex manual documents `shell_tool` as the stable default shell
feature and warns that read-only mode alone is not a sufficient secret
boundary. The B4 adapter therefore disables every feature above, web search,
user config and rules explicitly. B4.2 must fail closed if any required flag
or stable feature cannot be disabled.

## Privacy note

The installed read-only status commands are `claude auth status --json` and
`codex login status`. Both returned a closed ready result during the local
2026-07-26 capture. A second `codex login status` capture used an empty
temporary HOME, created no files, exited 1 and contained one exact closed
`Not logged in` line after a non-private warning. The adapter therefore
requires exit 0 plus an exact supported `Logged in using ...` line for ready,
and exit 1 plus the exact `Not logged in` line for attention; every other
combination is unknown. Vendor auth-status commands can return account email
and organization facts. The probe may map their result locally into `ready`,
`attention_required` or `unknown`, but must discard raw stdout/stderr before
building the signed inventory. No captured auth output belongs in QA evidence.
