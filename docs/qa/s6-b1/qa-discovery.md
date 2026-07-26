# S6.B1 QA discovery

## Product truth

This batch proves that an operator-authorized machine key enrolled, is still
active and has recently reached the control plane. It does not prove sandbox,
host integrity, engine availability or authority to execute work.

## Principal risks

- one token creates two runners under concurrency;
- a lost success response consumes the token but strands the runner;
- signature input differs between CLI, proxy, router and Worker;
- a hostile Host header changes the accepted audience;
- malformed or low-order Ed25519 keys bypass proof of possession;
- a replay advances liveness or a nonce authenticates different bytes;
- revocation leaves the principal or heartbeat path active;
- ledger contention commits identity state without its governance event;
- local/test human identity headers authorize the public runner route;
- token plaintext reaches D1, URLs, argv, environment or logs;
- liveness or UI language claims a sandbox/execution path that does not exist;
- tenant-scoped runner lists leak token or key-secret metadata.

## Frozen test oracles

- one token creates at most one principal, runner and enrollment event;
- same token/key after a dropped response returns the same byte-stable success;
- a different key receives the same rejection as an unknown token;
- every accepted request verifies exact body bytes, configured audience,
  observed pathname, timestamp and nonce;
- first heartbeat writes nonce and liveness atomically; an exact retry does
  neither and returns the stored response;
- token/runner lifecycle writes and their ledger event commit together;
- chain verification remains valid through forced contention;
- revoked always outranks pending/online/stale/offline;
- the only capability labeled real is enrollment, signed heartbeat, listing
  and revocation under `operator_trust`.
