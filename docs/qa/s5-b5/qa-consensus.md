# S5.B5 QA consensus

> Status: PASS
> Date: 2026-07-26

Fable, Codex and Opus agree on
`docs/adr/S5B5-exportable-decision-package.md`.

Frozen decisions:

- one post-proposal `ActionIntent` is the aggregate root;
- generated-on-demand deterministic Markdown, with no persisted package,
  payload duplicate or governance-ledger write;
- exact-byte SHA-256 stays external to its bytes and package id also names the
  intent;
- unrelated organization work cannot change the package hash;
- static intent-keyed D1 batch, 50-row critical evidence bound, 2 MiB body
  budget and disclosed advisory/300-event ledger windows;
- per-evidence content integrity and subset-safe ledger-entry recomputation,
  with explicit non-claims about continuity, preimages, artifact registration
  and signatures;
- every untrusted scalar is inert; literal bodies remain verbatim inside a
  dynamically safe fence;
- active human owner/admin bulk-export authority, metadata-only operational
  access log, no external dependency;
- JSON preview renders/discards the exact Markdown before asserting its hash;
- private/no-store HTTP, RFC-9530 `Repr-Digest`, strong fingerprint ETag and
  representation-hash CAS.

Fable returned `PASS` after the Opus architecture revisions. The first Opus
implementation review returned `BLOCK` and found three P1 issues: raw body
projection beyond the D1 byte bound, duplicate evidence distorting ledger
advisory windows and absent supersession truncation in the downloadable bytes.
Codex closed all three, added deterministic binary ordering, canonical
post-sort deduplication, tenant predicates, erasure hardening and the complete
authorization matrix.

The Opus delta review returned `PASS` with zero P0/P1 and explicitly marked all
three prior P1 findings closed. Automated regression, exact-byte API evidence
and desktop/mobile browser acceptance also passed. Fable, Opus and Codex
therefore agree that S5.B5 and the Sprint 5 exit are complete.
