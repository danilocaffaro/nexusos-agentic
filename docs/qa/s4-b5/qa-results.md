# S4.B5 QA Results

> Execution date: 2026-07-25

| Layer | Result | Evidence |
| --- | --- | --- |
| Type and lint | PASS | TypeScript and ESLint green |
| Unit | PASS | 40 tests, including presence sync, client payload, lease and roster view model |
| Migration | PASS | Empty and forward migration suite |
| HTTP integration | PASS | Governance and presence isolated D1 suites |
| Build/smoke | PASS | Production build and rendered HTML smoke |
| Browser functional | PASS | status, room enter/leave, exact room chat |
| Browser contention | PASS | passive banner, Messages auto-select cannot take over, explicit button required |
| Browser responsive | PASS | 390x844, body width equals viewport |
| Dependency audit | PASS | zero high-severity production findings |

## Defect found and resolved

The first browser contention pass showed that a tokenless command was treated
as takeover. The protocol now requires the explicit boolean `takeover: true`;
the domain, parser, client and integration tests were updated before acceptance.
An independent review then found ordinary passive-tab mutations were still
routed through that explicit flag. The client now has separate ordinary and
takeover queues, suppresses passive writes, disables passive room controls and
unit-tests that only the dedicated takeover path can emit the flag.
The convergence pass also removed a transient room leave/re-enter during the
initial Messages load and disabled status editing while the tab is passive.
The final presence-sync gate now waits only until the conversation list has
loaded successfully once, so a later list refresh error cannot keep a stale
room published after the user moves to a DM.

## Remaining scope

Agent presence waits for the authenticated runner. Roster pagination and SSE
replace the bounded polling baseline in later batches. Audio/video is an
optional media provider roadmap and is not part of this acceptance.
