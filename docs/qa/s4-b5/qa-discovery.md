# S4.B5 QA Discovery — Ephemeral Presence and Team Rooms

## Outcome under test

A human can see a privacy-safe roster, self-declare a status, enter or leave an
active shared room and open that room's persistent chat. A second client cannot
silently steal the current lease. Presence remains inert and ephemeral.

## Risk boundaries

- tenant and membership leakage through the roster;
- DM, handoff or archived room published as location;
- stale client renewing or releasing a newer lease;
- implicit takeover when a new tab has no token;
- browser lifecycle losing heartbeat or producing duplicate owners;
- UI claiming audio/video, agent presence or historical analytics that do not
  exist.

## Evidence surfaces

- pure domain tests for lease, expiry, release and room disclosure;
- migration tests for tenancy, membership and append/history constraints;
- isolated D1 HTTP integration with six-second TTL;
- browser flow against the migrated local D1;
- build, server-render smoke, lint, typecheck and dependency audit.
