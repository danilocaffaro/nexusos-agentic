# S6.B1 QA test plan

## Domain and cryptography

1. Generate, decode and re-encode canonical 32-byte token/key and 64-byte
   signature values; reject padding, standard base64 characters, bad trailing
   bits and wrong lengths.
2. Verify RFC 8032 known-answer signatures and reject tampered strings,
   malformed signatures, all-zero and known low-order public keys.
3. Prove deterministic PID/RID domain separation and byte-stable enrollment
   response rendering.
4. Verify exact canonical strings for enrollment and heartbeat, including
   encoded paths, double slash, query rejection, configured audience and the
   exact `{}` heartbeat body.
5. Exercise clock boundaries at 60 seconds past and 30 seconds future.
   Reject offsets, missing/lowercase `Z` and fractional precision other than
   exactly three digits.
6. Exercise liveness boundaries at pending, 89/90 seconds and 599/600 seconds,
   with revoked taking precedence.

## Migration and repository

7. Apply every forward migration to an empty database and assert new tables,
   indexes, foreign keys and triggers.
8. Reject tenant-mismatched/non-runner principals, identity mutation,
   `revoked -> active`, token un-consumption and inconsistent revocation fields.
9. Run eight concurrent enrollment requests for one token with distinct keys:
   exactly one principal, runner and `runner.enrolled` event survive.
10. Drop a successful response and retry the same token/key: return the same
    runner/body and create no row or ledger duplicate.
11. Retry a consumed token with a different key: byte-identical rejection to an
    unknown token and no orphan principal.
12. Race enrollment with another organization-ledger writer and verify dense
    sequence, previous hashes and full chain; persistent contention rolls back
    and returns bounded `conflict_retry`.
13. Duplicate public key through another token fails without consuming that
    token.
14. Issue, revoke token, enroll and revoke runner with the correct four typed
    events and no duplicate event on retry.
15. First heartbeat atomically stores nonce/response and advances last seen;
    exact replay returns the stored bytes without advancing it; changed request
    under the nonce is rejected.
    Revoke before replay and prove the cached success is no longer returned.
16. Expired replay rows are cleaned without deleting the live replay window.

## API and authority

17. Active owner/admin may issue and revoke; member/viewer, inactive,
    non-human, non-member and cross-tenant callers fail closed.
18. Enrollment works without a human session and ignores/rejects any attempt to
    authorize it through `X-Nexus-Test-*` headers.
19. Unknown, expired, revoked, consumed-wrong-key, malformed-key,
    bad-signature and skewed attempts return identical canonical 403 responses.
20. Host and forwarded-host spoofing cannot change the configured audience.
21. Revoked runner heartbeat fails immediately and does not mutate
    `last_seen_at`.
22. Runner list derives liveness and returns no token id/hash, private key,
    nonce or credential field.
23. Bodies and header values are size-bounded before expensive work; operational
    logs redact Authorization, signatures and key material.

## CLI and browser

24. CLI harness proves token is absent from argv/environment/logs, stdin mode
    works, prompt is hidden, directory is `0700` and private key is `0600`.
25. Ambiguous network failure preserves the staged key for idempotent recovery;
    definitive rejection removes a new unregistered key.
26. Owner issues a token once, copies a non-secret setup command, enrolls a
    real local runner and observes `pending -> online`.
27. Runner management shows the full operator-trust disclosure, public
    fingerprint, last seen, honest capability labels and revocation.
28. Desktop and 390x844 mobile layouts have no horizontal overflow; all actions,
    statuses, copy controls and dialogs are keyboard reachable.

## Regression

29. TypeScript, unit, migrations, every integration suite, production build,
    rendered smoke, ESLint, dependency audit and generated-schema drift pass.
30. Existing governance, artifacts, collaboration, presence and realtime paths
    remain unchanged.
