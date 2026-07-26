# S5.B5 QA consensus

> Status: READY
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

Fable returned `PASS` after the Opus revisions. Opus returned `PASS` after
adversarial cycles closed global-ledger coupling, self-hash, untrusted
Markdown, unbounded CPU/data and ledger-window coherence. Implementation may
proceed; final consensus remains contingent on automated and browser evidence
plus an Opus code review.
