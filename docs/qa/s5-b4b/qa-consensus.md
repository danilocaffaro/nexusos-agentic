# S5.B4b QA consensus

> Status: PASS
> Date: 2026-07-26

Fable, Codex and Opus agree on the revised architecture in
`docs/adr/S5B4b-cross-artifact-supersession.md`.

Frozen decisions:

- graph nodes and active-outbound uniqueness use stable artifact ids;
- exact head versions/hashes/sizes are evidence pins and are commit-time
  revalidated;
- the recursive cycle walk is tenant/status scoped and fails closed at 100;
- equal content hashes, self loops and unreadable targets are rejected;
- source content may be erased, but a target must be live and recomputed;
- active human owner/admin authority, no `ActionIntent`, no free text;
- retract then redeclare, with honest limits on redeclaration;
- one relation transition and one typed ledger event per D1 batch;
- no mutation of artifacts, reviews or decision evidence.

The local D1 recursive-trigger spike, automated gate and browser acceptance
passed. Opus returned `PASS` with no P0/P1 in the full review and again in the
post-fix delta review. Codex incorporated the recommended UI truthfulness,
race-error and integrity-copy fixes plus end-to-end ledger assertions. The
remaining depth/inbound scale fixtures, candidate search and ledger lookup
index are recorded non-blocking pre-GA hardening.
