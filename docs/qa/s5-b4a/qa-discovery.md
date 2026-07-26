# S5.B4a QA discovery

## Scope

This gate covers exact-version artifact reviews, human eligibility,
single-owner self-review, opinion replacement, ledger atomicity, tenant
isolation, payload erasure survival and the Outputs review surface.

## Primary risks

1. A review silently certifies a different or changed version.
2. A producer approves their work while another reviewer is eligible.
3. A viewer, agent, inactive principal or cross-tenant identity writes a review.
4. Two re-reviews leave multiple active opinions or duplicate ledger events.
5. A failed ledger append commits the review state without proof.
6. Review text leaks into the permanent hash chain.
7. Payload erasure deletes the assessment or permits a new blind review.
8. UI copy implies that an advisory opinion executes or approves an effect.
9. The implementation anticipates GitHub, Jira or the Sprint 6 runner as a
   hidden dependency.

## Architecture decision

Fable selected a specialized version-pinned review row with closed verdict and
reason vocabularies. Producer approval uses only the commit-time guarded
`solo_owner_ack` exception; self-authored change requests remain valid.
Re-review is append-preserving and atomic with two typed ledger events. No
`ActionIntent`, free-text rationale or proprietary integration is required.
