# S6.B4.3a release evidence

## Outcome

B4.3a is complete. NexusOS now has a dark, schema-free and route-free
foundation for exact engine-run input, encrypted prompt payloads, signed
engine claim bodies, lease-scoped prompt reads and prompt-free job
descriptors.

Nothing in this batch can create, claim, fetch or execute an engine run.
Execution, Sandbox and Streaming remain `roadmap`.

## Delivered contracts

- Incremental 56 KiB request reader that rejects every canonical decimal
  oversize as 413 before JSON parsing, with or without truthful
  `Content-Length`.
- Exact create grammar with only assigned runner, selected engine and prompt.
- Prompt validation at 1–8192 exact UTF-8 bytes, no normalization, fatal UTF-8
  decoding and unmatched UTF-16 surrogate rejection.
- The parsed value retains prompt bytes and digest but not a second plaintext
  string.
- `PromptCipher` port plus AES-256-GCM Web Crypto adapter with independent
  random 12-byte IV, 16-byte tag and defensive byte ownership.
- Canonical `NEXUS_PROMPT_CIPHER_KEYS` grammar with one active key, at most
  three canonically encoded 32-byte keys and a closed 503 for every missing,
  malformed or unavailable key.
- Exact AAD bytes `runId|organizationId|promptRef`.
- Explicit live-key coverage guard for safe rotation.
- Exact canonical claim, prompt-read, sentinel and nested prompt-free
  descriptor contracts with checked-in goldens.
- Typed Worker binding and one named 4096-byte signed-control-body bound.
- Automated dark gate proving no other production TypeScript module imports
  the new foundations.

## Review history

The first Opus 5 review returned `FAIL`, P0=0/P1=1/P2=8. The blocker was a
malformed keyring containing a JSON number such as `1e999`: `JSON.parse`
produced `Infinity`, then the unguarded canonicalizer threw a raw `TypeError`
instead of the required closed
`prompt_cipher_key_unavailable` 503.

The correction guards parse and canonicalization in one failure boundary and
adds the same test under explicit local opt-in, proving that a malformed
configured binding never falls back to the checked-in local key. The delta
also absorbed the inexpensive review hardenings:

- all decimal oversizes map to 413;
- the parser drops the plaintext string after exact encoding;
- caller context defects use a distinct generic internal error;
- stream chunks, key bytes, IV, ciphertext and tag have defensive ownership;
- signed canonicalizers round-trip through strict parsers/builders;
- the binding and bounds are typed/named;
- ten boundary and static test gaps were closed.

The final Opus delta independently reproduced the gates and returned
`PASS/GO`, P0=0/P1=0. Its remaining P2 findings are non-blocking and are
tracked for the first runtime wiring in B4.3c, especially exact mapping of the
internal context error and passing the local fallback flag only as
`NEXUS_ALLOW_LOCAL_IDENTITY === "1"`.

## Automated evidence

The final candidate passed:

- lint and TypeScript typecheck;
- 16 dedicated control-plane/cipher tests;
- 191 total unit tests;
- 91 runner tests;
- 24 migration/preflight tests, including real local Wrangler;
- governance/workspace, presence, realtime, artifacts, runners and runs API
  integration suites;
- production build and rendered smoke;
- production dependency audit with zero vulnerabilities;
- Drizzle schema generation with no drift;
- `git diff --check`.

## Rollback

The source modules have no production importer and the only existing-file
changes are additive type/constant declarations. Reverting this batch removes
the unused foundation and fixtures without a data migration or persisted
state transition.

## Next batch

B4.3b adds the forward-only dark storage grammar and exact triggers. No route
will write engine rows until the independently tested migration is complete.
