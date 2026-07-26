# S4.B5 QA Test Plan

1. Claim an empty lease and renew it with the exact key and fence.
2. Reject a fresh tokenless client while the lease is live.
3. Accept only an explicit takeover, increment the fence and reject the stale
   heartbeat and stale release.
4. Derive offline at expiry and delete expired state instead of retaining
   history.
5. Race roster cleanup with expired reclaim without false ownership.
6. Reject malformed session, status, token and takeover fields.
7. Reject direct, handoff, archived and non-member room locations.
8. Isolate roster by tenant and redact room outside shared active membership.
9. Require active workspace membership for human roster entries.
10. Permit an active non-human principal at the schema boundary for a future
    authenticated runner and reject disabled/non-member cases.
11. In the browser, change status, enter/leave a real room and open its exact
    persistent chat.
12. Force a competing lease, observe passive mode, navigate to Messages with an
    auto-selected room and prove no ordinary mutation emits takeover; require
    the explicit takeover button to resume.
13. At 390x844, preserve all room controls and prevent horizontal overflow.
14. Verify media controls are disabled and labeled roadmap.
