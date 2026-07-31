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
  const header = componentSource("function AppHeader(", "function TodayView(");
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

test("Today rejects fake live counts and routes actionable CTAs to real data", () => {
  const source = componentSource("function TodayView(", "function ProjectView(");

  assert.match(source, /data-testid="today-visioning-disclosure"/u);
  assert.match(source, /VISIONING · DADOS ILUSTRATIVOS/u);
  assert.match(source, /Tempo operacional não observado/u);
  assert.match(source, /nenhum evento foi contado/u);
  assert.match(source, /Presença não conectada/u);
  assert.match(source, /VISIONING · SEM EXECUÇÃO OBSERVADA/u);
  assert.match(source, /onClick=\{onProject\}/u);
  assert.match(source, /onClick=\{onInbox\}/u);

  for (const falseClaim of [
    "11h 42m",
    "126 eventos",
    "12 agents online",
    "Briefing compartilhado",
    "Novo WorkItem criado",
    "Terminal de autenticação aberto",
  ]) {
    assert.equal(source.includes(falseClaim), false, falseClaim);
  }
  assert.doesNotMatch(source, /\bnotify\b/u);
});

test("Releases is a disabled example until GitHub supplies evidence", () => {
  const source = componentSource("function ReleasesView(", "function LedgerView(");

  assert.match(source, /data-testid="releases-visioning-disclosure"/u);
  assert.match(source, /VISIONING · GITHUB NÃO CONECTADO/u);
  assert.match(source, /Sync indisponível · roadmap/u);
  assert.match(source, /Versão não observada/u);
  assert.match(source, /EXEMPLOS DE PULL REQUESTS/u);
  assert.match(source, /GitHub não conectado/u);
  assert.doesNotMatch(source, /\bonClick=/u);
  assert.doesNotMatch(source, /\bnotify\b/u);

  for (const falseClaim of [
    "Sincronização com GitHub concluída",
    "PRODUCTION · HEALTHY",
    "LAST VERSION DEPLOYED",
    "v2.18.4",
    "0.08%",
    "182ms",
    "Deployed há 42 min",
  ]) {
    assert.equal(source.includes(falseClaim), false, falseClaim);
  }
});

test("Automations remains a disabled example until a scheduler supplies facts", () => {
  const source = componentSource(
    "function AutomationsView(",
    "function CommandPalette(",
  );

  assert.match(source, /data-testid="automations-visioning-disclosure"/u);
  assert.match(source, /VISIONING · NENHUM SCHEDULER CONECTADO/u);
  assert.match(source, /Nenhuma automação foi criada, pausada ou executada/u);
  assert.match(source, /Automation Studio · roadmap/u);
  assert.match(source, /Pausar indisponível/u);
  assert.doesNotMatch(source, /\bonClick=/u);
  assert.doesNotMatch(source, /\bnotify\b/u);
  assert.doesNotMatch(source, /\buseState\b/u);

  for (const falseClaim of [
    "Automation Studio aberto",
    "Automação retomada",
    "Automação pausada",
    "99.4%",
    "$286",
    "18 min",
  ]) {
    assert.equal(source.includes(falseClaim), false, falseClaim);
  }
  assert.match(pageSource, /Ver exemplos de automações/u);
  assert.doesNotMatch(pageSource, /Pausar automações do Orion Data/u);
});
