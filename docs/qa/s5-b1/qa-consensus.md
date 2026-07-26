# S5.B1 QA consensus

## Architecture

Fable converged on a local-first, provider-independent artifact registry. D1 is
authoritative for the initial Markdown slice, payloads are isolated behind a
port and no proprietary integration is required for core output provenance.

## Implementation review

The first Opus 5 review diverged on a deep-link ordering bug, payload persistence
outside the version transaction, overloaded trigger errors, stale detail state,
unverified content integrity and missing negative tests. Those findings were
corrected.

The first final pass then found one remaining P1 race in deep-link/list ordering
and P2 gaps around conflict resubmission, payload deletion and negative
coverage. Request generations now reject stale list responses, a conflicted
editor is structurally unable to submit, payload deletion is forbidden and the
gates cover simultaneous append, cross-tenant payload access, tamper detection
and exact erasure transitions.

The final Opus 5 re-review reported `CONVERGE` with no P0/P1. Its remaining P2
observations were also tightened with pure UI guard tests, explicit remote-test
skip reporting and partial/erased payload negative cases.

## Decision

CONVERGE. The full release gate is green. The architecture preserves
immutable provenance while keeping erasable content and future blob storage
separate. Browser evidence proves direct navigation, real lineage, concurrency
recovery and responsive behavior without GitHub, Jira, R2 or realtime
dependency.
