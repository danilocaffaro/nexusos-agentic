# S5.B5 QA discovery

## Product truth

The package is an authorized export, not a persisted record or external
effect. It must close output → producer → evidence → decision while preserving
erasure and never implying a digital signature.

## Principal risks

- a second server-side payload copy bypasses governed erasure;
- unstable ordering, caller identity or request time changes bytes;
- a self-hash claim cannot be verified;
- rendered relevant ledger rows are mistaken for a complete portable chain;
- corrupt or concurrently erased evidence enters a package without a
  per-evidence warning;
- arbitrary Markdown forges headings, fences or verification copy;
- truncation silently removes decision-critical evidence;
- cross-tenant composition amplifies disclosure;
- preview and download observe different truth without warning.

## Frozen test oracles

- identical snapshot means byte-identical Markdown and identical SHA-256;
- the hash covers exactly the downloaded bytes and is not embedded in them;
- relevant ledger-entry hashes are recomputed without claiming omitted-chain
  continuity, payload preimages or artifact registration;
- erased bodies remain unavailable while metadata/hashes remain;
- no package, payload or ledger row is created by any number of exports;
- unrelated organization events do not change decision-package bytes;
- critical evidence is complete or the export fails closed;
- every advisory/payload omission is machine-readable and human-visible.
- included ledger entries never exceed 300 and refer only to rows actually
  present in the package windows.
