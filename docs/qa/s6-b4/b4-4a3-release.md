# S6.B4.4a3 release evidence

## Outcome

B4.4a3 extends the existing rollback-safe outbox-v3 substrate with the dark
`engine.complete` declaration contract. It adds no network caller, CLI command,
supervisor or provider process. Execution remains `roadmap`.

A pending declaration stores the exact canonical completion body required by:

```text
POST /api/runs/:runId/engine-complete
```

The envelope binds `runId` for route derivation and binds its base
`operationId` to the same value inside the canonical body. The request digest,
operation id and run id survive terminal settlement. Lease, fence and bounded
provider excerpts remain only inside the replay body and are removed from the
first-class terminal tombstone.

## Exact shapes

Pending entries have exactly:

```text
bodyBase64, bodySha256, createdAt, declarationKind, entrySha256,
operationId, response, runId, status, updatedAt, v
```

Terminal entries have exactly:

```text
bodySha256, createdAt, declarationKind, entrySha256, operationId,
responseSha256, responseStatus, runId, settledAt, status, updatedAt, v
```

`bodyBase64` and response bytes are absent after settlement. The tombstone is
still a valid v3 entry, is never replayed and is pruned by the existing
seven-day policy.

## Parser parity and identity safety

The local runner parser mirrors the Worker completion parser:

- exact canonical JSON and top-level keys;
- fixed engine, result and reason vocabularies;
- lease, operation, fence, timestamp and version bounds;
- stream byte, digest, truncation and result-consistency rules;
- combined decoded excerpt bound of 1024 bytes;
- independent `cancelRequested` and `timedOut` facts.

Both parsers consume the same checked-in maximal vector. The 4096-byte
transport and parser limit is consumed from the same shared contract rather
than being accidentally coupled to the engine-report limit.

The declaration registry now exposes a per-kind body limit and a non-empty
body identity. Every body identity key must equal the corresponding envelope
key. This removes the prior risk that a new kind without `reportId` could pass
the old report-specific `undefined === undefined` comparison.

The frozen `engine.report` pending and acknowledged fixtures continue to parse
without byte or shape changes.

## Future delivery classification

The batch freezes a pure, v3-native response classifier for the later
supervisor:

- HTTP 200 plus a valid exact acknowledgement becomes `acked`; an invalid
  acknowledgement or any other 2xx status is a protocol fault and remains
  `pending`;
- network failure, 429, 5xx, `409 nonce_reused` and `409 conflict_retry`
  remain `pending`;
- `lease_superseded`, `run_unavailable`, `lease_expired` and
  `engine_deadline_exhausted` become `superseded`;
- authentication failures, `operation_conflict`, engine/version mismatch,
  unproven cancellation, 410 and other terminal 4xx become `rejected`.

No server response maps to `abandoned`. That state is reserved for a local
response-free settlement, because the v3 contract deliberately forbids
response facts on an abandoned tombstone.

The tombstone validator independently enforces the declared acknowledgement
status for each registry kind: completion acknowledgement is exactly HTTP 200,
engine-report acknowledgement remains exactly HTTP 201, and rejected or
superseded entries cannot carry a successful 2xx status.

Authentication rejection is intentionally terminal in this frozen
classification. B4.4a4 must surface it as operator attention; it must not
silently retry possible clock-skew or runner-record failures after scrubbing.

## Automated evidence

The focused candidate proves:

- exact pending replay bytes and route derivation;
- shared maximal-vector and limit parity;
- a shared twelve-case differential negative corpus accepted by neither the
  Worker parser nor the runner parser, including array-coercion, duplicate
  key, prototype key, BOM and invalid UTF-8 attacks;
- canonical body and acknowledgement parsing;
- every response-classification branch;
- operation/body identity drift, checksum drift and cross-kind confusion fail
  closed;
- acknowledged and abandoned variants validate without replay bytes;
- request and response markers do not survive terminal settlement;
- repeated terminal transition is byte-stable;
- acknowledged completion tombstones prune after seven days;
- the existing engine-report delivery and outbox suites remain green.

The final candidate passed:

- 218 unit tests;
- 99 runner tests, including 96 top-level cases;
- 38 migration, storage and preflight tests;
- all seven isolated API integration suites;
- production build and two Worker/rendered-HTML smoke tests;
- TypeScript, ESLint and Oxlint;
- production dependency audit with zero vulnerabilities at the configured
  high-severity gate;
- Drizzle generation with no schema drift;
- `git diff --check`.

The initial Opus gate found one P0 parser-coercion defect and four P1 contract
or evidence gaps. The corrected delta uses strict string guards, handles
`conflict_retry`, composes HTTP 200 with exact acknowledgement validation,
shares the negative corpus across both parsers and records this full pipeline.
The corrected delta and the final two-P2 hardening delta both returned
`PASS/GO`, P0=0/P1=0. No findings remain open for this batch.

## Rollback and next batch

Rollback removes the new registry kind and parser. This dark batch has no
producer, so it cannot leave a completion file behind. After B4.4a4 introduces
one, a downgrade must first drain or explicitly preserve its entries: an older
runner will quarantine an unknown declaration kind as corrupt rather than
rewrite it.

B4.4a4 may introduce the five-state attempt journal, single-lock serve loop,
fake supervisor and the actual signed `engine.complete` caller. It must consume
this exact outbox contract and may not introduce a second persistence or
pruning path. Real Claude Code and Codex argv remain B4.4b.
