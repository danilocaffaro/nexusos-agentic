# S4.B6 transport QA consensus

## Architecture

Fable converged on a hibernating Durable Object per organization with D1 as the
sole authority. Its follow-up review preferred publish-time recipient
resolution over stale socket-tag authorization. The hub therefore performs only
transport intersection and never decides membership.

## Implementation review

Opus 5 found no P0 or P1 and returned `CONVERGE`. Its P2 findings were addressed:

- removed a vacuous cross-tenant delivery assertion;
- paired local upgrade resets with Worker health and authorized-read evidence;
- added payload-free failure reporting;
- chunked large recipient sets under a mutually consistent byte bound;
- removed publish-driven socket expiry that did not provide a time guarantee;
- added same-origin browser enforcement;
- avoided reserved close-code echo.

## Decision

The server-side realtime transport is accepted for S4.B6 batch 2. D1 remains
the source of truth, polling remains the complete fallback, and no paid service
is required for the product to function.
