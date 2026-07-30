# Private Sites alpha

This deployment mode is a bounded, single-user NexusOS alpha. It is not public
authentication and it is not a multi-tenant identity system.

## Required Sites boundary

- Keep the Sites project access mode `custom`.
- Allow exactly one user and no groups.
- Set `NEXUS_PRIVATE_ALPHA_OWNER_EMAIL` to that same user's email.
- Do not expose the Worker through another ingress. NexusOS trusts
  `oai-authenticated-user-email` only at the Sites authenticated dispatcher
  boundary.

The application maps that one allowlisted email to the fixed alpha owner and
workspace. A missing, different, duplicated, or malformed forwarded email is
rejected. There is no self-service account creation, workspace selection, email
change migration, or second-user invitation in this alpha.

## Required hosted runtime values

Set these through Sites, not in `.openai/hosting.json` or source control:

| Variable | Required value |
| --- | --- |
| `NEXUS_PRIVATE_ALPHA_IDENTITY` | Exactly `1` |
| `NEXUS_PRIVATE_ALPHA_OWNER_EMAIL` | The one Sites-allowed user |
| `NEXUS_MESSAGE_INTEGRITY_KEY` | A secret of at least 32 UTF-8 bytes |

Leave `NEXUS_ALLOW_LOCAL_IDENTITY` and `NEXUS_ALLOW_TEST_IDENTITIES` unset.
Private alpha refuses to start its identity path if either impersonation flag is
enabled, if the integrity key is missing or weak, or if the request uses a
localhost origin.

The D1 binding remains `DB`; R2 is not used. The existing fixed workspace seed
is reused so the alpha can exercise project, team, agent, collaboration,
artifact, and governance flows against durable D1 state.

Build first, then create the upload artifact with
`npm run sites:package -- /absolute/archive.tgz`. This deterministic packaging
emits complete non-trigger migration statements for the Sites D1 migration
boundary. Before serving any private-alpha request, the Worker derives and
installs the exact final trigger set from the canonical migrations with
`prepare()` and verifies every trigger name. It returns
`database_integrity_unavailable` with HTTP 503 instead of serving on a partial
integrity boundary.

## Explicit limitations

- Sites custom access and its forwarded identity header are the authentication
  boundary; the app does not verify a separate header signature.
- Authorization is intentionally one owner in one fixed workspace.
- Local CLI/test identity remains a development-only localhost facility and is
  incompatible with private alpha mode.
- Provider OAuth/CLI availability, autonomous agent execution, external
  connectors, and GitHub synchronization remain separate capabilities and are
  not implied by this deployment mode.
