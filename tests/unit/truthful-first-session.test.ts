import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pageSource = readFileSync(
  new URL("../../app/page.tsx", import.meta.url),
  "utf8",
);

function componentSource(start: string, end: string): string {
  const startIndex = pageSource.indexOf(start);
  const endIndex = pageSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `${start} must exist`);
  assert.notEqual(endIndex, -1, `${end} must exist after ${start}`);
  return pageSource.slice(startIndex, endIndex);
}

test("Home resolves workspace state before choosing onboarding or Projects", () => {
  assert.match(pageSource, /useState<View>\("project"\)/u);
  assert.match(pageSource, /fetch\("\/api\/workspace"/u);
  assert.match(pageSource, /readWorkspaceBootstrap\(payload\)/u);
  assert.match(
    pageSource,
    /status === "loading" \? "workspace-loading" : "workspace-error"/u,
  );
  assert.match(pageSource, /if \(workspaceSummary\.setupRequired\)/u);
  assert.match(
    pageSource,
    /<Onboarding\s+reloadWorkspace=\{refreshWorkspace\}/u,
  );
  assert.doesNotMatch(pageSource, /localStorage/u);
  assert.doesNotMatch(pageSource, /Explorar workspace ativo/u);
  assert.doesNotMatch(pageSource, /Rever onboarding/u);
});

test("first-run onboarding posts the exact setup contract and reconciles before entering", () => {
  const source = componentSource("function Onboarding(", "function Sidebar(");

  assert.match(source, /data-testid="first-run-onboarding"/u);
  assert.match(source, /validateFirstRunStep\(draft, step\)/u);
  assert.match(source, /buildSetupRequest\(draft\)/u);
  assert.match(source, /fetch\("\/api\/setup", \{/u);
  assert.match(source, /method: "POST"/u);
  assert.match(source, /body: JSON\.stringify\(built\.request\)/u);
  assert.match(source, /submitLatchRef\.current/u);
  assert.match(source, /readWorkspaceState\(payload\)/u);
  assert.match(source, /const resolution = await reconcileSetup\(\)/u);
  assert.match(
    source,
    /if \(!workspace\.setupRequired\) \{\s*onComplete\(workspace\)/u,
  );

  for (const forbidden of [
    "VISIONING",
    "DEMO",
    "Aurora",
    "Atlas",
    "GitHub",
    "OAuth",
    "skills",
    "localStorage",
    "Explorar workspace",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("shell identity and command context come from the workspace response", () => {
  const sidebar = componentSource("function Sidebar(", "function AppHeader(");
  const header = componentSource("function AppHeader(", "function ProjectView(");
  const command = componentSource(
    "function CommandPalette(",
    "async function fetchWorkspaceState(",
  );

  assert.match(sidebar, /workspace\.organization\.name/u);
  assert.match(sidebar, /workspace\.currentPrincipal\.displayName/u);
  assert.match(header, /currentPrincipal\.displayName/u);
  assert.match(command, /organizationName/u);
  for (const source of [sidebar, header, command]) {
    assert.doesNotMatch(source, /Aurora|Rafael|initials="RC"/u);
  }
});

test("production navigation exposes only operational surfaces", () => {
  const viewType = componentSource("type View =", "type Agent =");
  const navigation = componentSource("const navItems:", "function BrandMark(");
  const sidebar = componentSource("function Sidebar(", "function AppHeader(");
  const command = componentSource(
    "function CommandPalette(",
    "function readWorkspaceState(",
  );
  const dispatcher = componentSource(
    "const currentContent = (() => {",
    "if (workspaceLoadStatus === \"loading\")",
  );

  for (const removed of ["today", "releases", "automations"]) {
    for (const source of [viewType, navigation, command, dispatcher]) {
      assert.doesNotMatch(source, new RegExp(`"${removed}"`, "u"));
    }
  }
  assert.match(sidebar, /onNavigate\("project"\)/u);

  for (const preserved of [
    "messages",
    "rooms",
    "project",
    "inbox",
    "outputs",
    "agents",
    "runners",
    "providers",
    "ledger",
  ]) {
    assert.match(navigation, new RegExp(`id: "${preserved}"`, "u"));
    assert.match(command, new RegExp(`"${preserved}"`, "u"));
  }

  assert.doesNotMatch(
    command,
    /Aurora|Atlas|PR #482|Nexus Commerce|Checkout|DEC-204/u,
  );
});

test("project detail renders only persisted operational surfaces", () => {
  const source = componentSource(
    "function ProjectOperatingView(",
    "function MessagesView(",
  );

  assert.match(source, /PROJETO · \{project\.status\.toUpperCase\(\)\}/u);
  assert.match(source, /Work · real/u);
  assert.match(source, /Time híbrido · real/u);
  for (const unavailable of [
    "AURORA LABS",
    "Project Room",
    "visioning",
    "roadmap",
    "MEMORY GRAPH",
    "EVIDENCE",
    "Checkout",
    "Atlas",
    "Rafael",
  ]) {
    assert.equal(source.includes(unavailable), false, unavailable);
  }
});
