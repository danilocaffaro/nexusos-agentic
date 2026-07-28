# S6.B4.4a5.5a release evidence

## Outcome

B4.4a5.5a adds the dark runner-side acquisition boundary required before a
governed engine attempt can exist:

- deterministic, domain-separated claim operation identity;
- byte-exact claim and prompt-read request contracts;
- canonical lease-descriptor parsing and local temporal acceptance;
- exact `claimed` and `starting` journal producers;
- one total bounded claim HTTP effect; and
- one total bounded prompt HTTP effect with explicit plaintext ownership.

No public command imports these modules. The batch does not claim a run, read a
real prompt, renew or cancel a lease, launch a supervisor, resolve a provider
executable or spawn Claude Code/Codex. Arbitrary execution remains `roadmap`.

## Activation-safe split

Fable rejected a monolithic activation batch and froze three smaller slices:

1. B4.4a5.5a: these dark contracts and HTTP effects;
2. B4.4a5.5b: a still-dark attempt runtime for lease lifecycle, executable
   revalidation, supervisor handoff and crash gaps; and
3. B4.4a5.5c: explicit `serve --engine-run <runId> --engine <engine>`
   activation under the existing single process owner.

There is no polling or ambient discovery route in this split. The future
operator supplies one run ID explicitly, and a process may own at most one
live engine attempt.

## Claim contract

The claim operation ID is:

```text
op_ + first32hex(sha256(canonicalJson({
  attemptId,
  domain: "nexus-runner-engine-claim-operation-v1"
})))
```

The domain is distinct from
`nexus-runner-engine-outbox-operation-v1`. The signed body is exactly
`{engine,operationId}`, the path is exactly
`/api/runs/{runId}/engine-lease/claim`, and the signature domain is exactly
`nexus-runner-engine-lease-claim-v1`.

The response parser accepts only canonical UTF-8 JSON of at most 4,096 bytes.
It closes the top-level and nested key sets; validates run, lease, prompt and
engine identities; requires canonical timestamps; enforces fence, timeout,
prompt and version bounds; and requires the exact output limits:

```json
{"stderrBytes":65536,"stdoutBytes":262144}
```

Temporal acceptance occurs only after the server response. A descriptor whose
lease expires at or before the local observation time is rejected as
`lease_expired`. Otherwise the effective timeout is:

```text
min(descriptor.timeoutMs, deadlineAt - nowMs - 30_000)
```

and must remain at least 270,000 ms. `lease_expired` has priority over
`engine_deadline_insufficient`. A rejected descriptor never becomes a
`starting` record.

## Prompt plaintext boundary

Prompt-read signs the canonical body `{fence,leaseId,promptRef}` for the exact
`/api/runs/{runId}/prompt` path and
`nexus-runner-engine-prompt-read-v1` domain.

The HTTP effect allocates one fixed 8,193-byte scratch. A successful response
must be `application/octet-stream`, stay at or below 8,192 bytes, match all
three `x-nexus-prompt-*` headers and match the descriptor's byte count,
reference and SHA-256. Replay is true only for the exact header value `1` and
does not bypass integrity verification.

Success copies the exact plaintext once into a caller-owned `Uint8Array`,
zeros the scratch and returns only safe metadata in `outcome`. Every other
path zeros the scratch and returns `promptBuffer: null`. The outcome contains
no plaintext, base64 representation, response fragment or private exception
text. The future a5.5b caller owns and must zero the success buffer after the
supervisor handoff.

Allocator failure, invalid or hostile typed arrays, overridden `fill`, stream
overflow, excessive reads, lying lengths, malformed read frames, accessors,
cancellation failure and release failure all collapse into the closed result
algebra without rejecting the outer promise.

## Closed HTTP outcomes

Claim returns exactly one of:

- `descriptor`;
- `descriptor_rejected`;
- `denied`;
- `response_error`; or
- `transport_error`.

Prompt returns the same semantic families using `prompt` or
`prompt_rejected`, always inside `{outcome,promptBuffer}`.

Known server denials retain only a closed error token and one of
`auth`, `rejected`, `superseded` or `retryable`. The matrices cover the real
claim and prompt routes, including prompt `409 conflict_retry`.
Unknown status/code pairs are protocol errors. Bounded malformed responses
from transient edge statuses 429, 500, 502, 503 and 504 are retryable, so an
HTML gateway response cannot become a deterministic local-contract failure.

Response `Content-Length` is optional because the current routes and edge may
stream it. When present it must be canonical, bounded and equal the bytes
read. Non-200 bodies are capped at 4,096 bytes even on the prompt route.

## Journal commitments

`createClaimedRecord` commits the exact canonical claim body SHA-256 and
derived claim operation ID. `createStartingRecord` copies the exact lease,
fence, run, engine, version, expiry, deadline, timeout, output bounds and
prompt metadata from the accepted descriptor.

Both producers pass the existing append-only journal parser and cross-record
validator. They reject run/engine drift, backwards creation time, creation
after lease expiry and checksum drift. Neither record contains prompt
plaintext.

## Adversarial acceptance

The focused 98-test matrix covers:

- golden and domain-separated operation IDs;
- exact canonical request bodies and descriptor round trips;
- every identifier, timestamp, version, timeout, fence, prompt and output
  boundary;
- expired-lease and deadline-budget precedence;
- every known claim and prompt status/error pair;
- wrong pairs, unknown pairs and bounded edge HTML;
- absent, malformed, lying and overflowing response lengths;
- exact 4,096/8,192 boundaries and the next byte;
- 1,024-read cap, zero chunks, invalid frames and `NaN` chunk lengths;
- replay revalidation;
- mismatch of payload, byte count, reference and hash;
- caller input/body/path/domain/checksum drift before network access;
- scratch non-aliasing, success transfer and zeroization on every failure;
- invalid allocators, hostile typed-array subclasses and method accessors;
- reader/body cancellation plus safe lock release;
- Symbol, non-enumerable, accessor and descriptor-trap inputs;
- claimed/starting journal correlation and chronology; and
- absence of active runner, provider, child-process and serve imports.

The independent local adversarial oracle ended `GO`, P0=0/P1=0/P2=0. The
focused matrix was rerun independently in the local workspace.

## Frozen active runner

The following inherited files remain byte-identical to base `36753e3`:

| Path | SHA-256 |
|---|---|
| `runner/nexus-runner.mjs` | `bb90298f172107a0b5b4d48d9fd0da6999e2945b204aed98ec894b88431acede` |
| `runner/engine-serve-command.mjs` | `8a8002683989ccea0e5352da1aac5d920ccae8655af3904a209d17140f9e3ae0` |
| `runner/engine-serve-cycle.mjs` | `b44b6a0c3fd495402b843eb4efaf4bf58fbeddf1e6199e367561b5e4eb094822` |
| `runner/engine-supervised-run.mjs` | `3a8447a2ff77160b95a6ea4fb8bbd60ca0f1ebb3877a6bdaab390dcbe0a5bbcd` |
| `runner/engine-supervisor-child.mjs` | `0ef19780d293f93910b875d5204bf17fcfbd94d0e4a1e20445500233d85fd3e6` |
| `runner/engine-adapters.mjs` | `ce6693e54337aa4cd2c317ccf8187531f8edebc2d375713cfd0b4b0cd32409ec` |
| `runner/attempt-journal-contract.mjs` | `3fbbc2ba00b2d7097c4344d79f2037677c4be0ea9c34c56b891aeb3e0af09e69` |
| `runner/outbox-contract.mjs` | `be75b2c1d0637ef309163a36b27513edb60058459215e59c3ef6bc9af8efdad8` |

## Review evidence

The exact architecture session was
`5dfa9f8d-d555-4277-b5e8-ff2e59ede9a9`. Its normative passes used only
`claude-fable-5` with read-only tools. Fable corrected the impossible
pre-HTTP deadline assertion, froze post-response acceptance, the two-part
prompt ownership result, the closed denial matrices, optional response length,
the real prompt `conflict_retry` case and `lease_expired` priority.

The exact implementation review session is
`892a8cc1-a3f6-46cc-9ce0-4b7bbfe9f2f6` using `claude-opus-5`.
Its initial P1 found the hostile-scratch totality gap. Successive deltas closed
outer-promise rejection, universal scratch erasure, cancellation, expiry,
closed-record reflection, edge overflow classification, unsafe chunk lengths
and malformed-reader release. The final delta returned `PASS/GO` with no P0
or P1.

Claude's sandbox did not permit it to execute Node. All executable evidence
below was run independently in the local workspace.

## Release gate

The exact final candidate passed:

- focused claim/prompt acceptance: 98/98;
- complete unit suite: 282/282;
- complete runner suite: 360/360;
- migration and preflight suite: 38/38;
- all seven API integration suites;
- production build and rendered-artifact smoke tests: 2/2;
- repository-wide ESLint and Oxlint;
- production dependency audit with zero vulnerabilities;
- exact seven-path allowlist; and
- `git diff --check`.

## Capability truth

This batch makes no execution claim. The new modules remain unreferenced by
the public runner. Claim acquisition, prompt retrieval, lease maintenance,
supervisor launch and provider CLI execution remain inactive. The overall
execution capability remains `roadmap` until B4.4a5.5b/a5.5c and the B4.5
product/evidence gate pass.

## Parallel-pair integration

Team A commit `58bd702` landed before changes from the S7.B6 source commit
`5a1e902`, as required by the critical-path rule. Those changes were integrated
on main as `a7c0a51`. The independent guard predicted one documentation-only
conflict and produced pre-evidence tree
`13ac7e9958938ec012040cd16d7ef71be140c576`. The real integration commit
matched that tree exactly, preserved the Sprint 6 and Sprint 7 hunks, and left
all eight frozen runner hashes unchanged.

The exact pre-evidence integrated candidate passed 98/98 focused claim/prompt tests, 26/26
focused GitHub delivery/projection tests, 298/298 unit tests, 360/360 runner
tests, 38/38 migration/preflight tests, all seven integrations, production
build, smoke 2/2, ESLint, Oxlint, `git diff --check` and a production audit
with zero vulnerabilities. The guard closed at GO with P0=0/P1=0; its sole
documentation P2 was resolved by the tree-matched plan paragraph.
