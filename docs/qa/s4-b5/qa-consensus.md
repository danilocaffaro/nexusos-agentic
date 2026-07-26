# S4.B5 QA Consensus

Status: CONVERGED

Architecture constraints already converged with Fable: existing room
conversations are the location model; presence is a replaceable D1 lease with
no history; DMs and handoffs are never locations; human status is
self-declared; agent presence requires the future authenticated runner; media
is optional and cannot become a core dependency.

Fable converged on the architecture constraints before implementation. Opus 5
then found and validated fixes for implicit passive-tab takeover, missing
client payload coverage, passive control accuracy and conversation-load
presence flaps. The final focused review found no unresolved P0/P1/P2 and
ended `CONVERGE`.

Accepted evidence:

- 40 unit tests and 3 migration tests;
- isolated governance and presence D1 integration suites;
- production build, rendered smoke, lint and production dependency audit;
- browser status, enter/leave, exact room chat and mobile layout;
- passive Messages room selection preserved the competing session/fence;
- room-to-chat navigation preserved the same published room id;
- Fable architecture consensus and Opus 5 implementation convergence.
