# S5.B3 QA consensus

## Architecture

Fable recommended a specialized `intent_artifact_evidence` write model instead
of a generic polymorphic graph. The accepted model uses exact artifact-version
foreign keys, `basis/outcome` relations, hash/size pinning, phase gates,
pre-decision supersession and metadata-only ledger events. GitHub, Jira, R2 and
the future runner remain optional or later capabilities.

## Adversarial review

Opus 5 validated the architecture and found one P1: the original conditional
ledger `INSERT ... SELECT` could theoretically write zero rows without aborting
the surrounding evidence mutation. The fix replaced it with a mandatory
insert plus `ledger_entries_validate_evidence_event`, which proves the matching
tenant, intent, row, actor, state and timestamp and aborts the D1 batch on
mismatch or replay. Both statement change counts are also asserted.

Opus requested bounded-picker disclosure and direct tests for outcome,
partial-active uniqueness and tenant/project boundaries. These were added.
Its re-review returned PASS. The remaining P2 observations were then closed:
duplicate/forged ledger-event tests were added and an indexed
`(organization, payloadRef, kind)` lookup prevents an organization-wide scan.
The picker now orders by version creation time, and an already-erased version
returns a specific conflict instead of not-found.

## Consensus

PASS. S5.B3 preserves a decision's exact evidence basis without retaining a
second copy of erasable content, and every evidence state change is atomic with
one verifiable ledger event.
