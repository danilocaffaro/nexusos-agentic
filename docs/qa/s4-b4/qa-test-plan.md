# S4.B4 QA Test Plan

| ID | Layer | Scenario | Expected |
| --- | --- | --- | --- |
| ATT-001 | Migration | Apply all migrations from empty | Tables, indexes and triggers exist |
| ATT-002 | Migration | Insert malformed/foreign/member item | Database rejects |
| ATT-003 | Migration | Update references or hard-delete | Database rejects |
| ATT-004 | Migration | Resolve as decided/expired | Legal terminal history |
| ATT-005 | Migration | Backfill owner/admin/member | Only owner/admin receive one copy |
| ATT-006 | API | Retry same proposal key | Same intent, no duplicate attention |
| ATT-007 | API | Owner and admin list | Each sees only own copy |
| ATT-008 | API | Other principal/tenant reads or writes | No enumeration or mutation |
| ATT-009 | API | Missing/string/zero/stale version | Distinct 400/409; row unchanged |
| ATT-010 | API | Mark seen | Intent remains proposed |
| ATT-011 | API | Approve | All copies resolve in same transaction |
| ATT-012 | API | Count and invalid cursor | Cheap exact count; invalid cursor 400 |
| ATT-013 | API | Focus older than 20 intents | Exact target returned first |
| ATT-014 | API | Missing/cross-tenant focus | Target absent; no leak |
| ATT-015 | Unit | Focus target missing | No fallback intent selected |
| ATT-016 | Unit | Poll refresh after pagination | Deeper rows retained; stale shrink reset |
| ATT-017 | Browser | Proposal → badge → seen | Counts and copy remain honest |
| ATT-018 | Browser | Inbox → exact ledger → approve | Exact id, then item and badge disappear |
| ATT-019 | Browser | 800px stacked selection | Detail receives focus and scrolls into view |
| ATT-020 | Product | Capability labels | Real/simulated/roadmap boundaries explicit |

