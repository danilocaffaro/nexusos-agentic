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

test("the first session opens the real persistent project surface", () => {
  assert.match(pageSource, /useState<View>\("project"\)/u);
  assert.match(
    pageSource,
    /if \(view === "welcome"\) \{\s*return <Onboarding onEnter=\{\(\) => setView\("project"\)\} \/>;/u,
  );
  assert.match(pageSource, /onReset=\{\(\) => navigate\("welcome"\)\}/u);
  assert.match(pageSource, />\s*Rever onboarding\s*</u);
});

test("the optional onboarding is a dominant, effect-free visioning tour", () => {
  const source = componentSource("function Onboarding(", "function Sidebar(");

  assert.match(source, /data-testid="onboarding-visioning-disclosure"/u);
  assert.match(source, /VISIONING · DEMO/u);
  assert.match(source, /nada aqui conecta provedores/u);
  assert.match(source, /Integração roadmap/u);
  assert.match(source, /Abrir Projetos reais/u);
  assert.ok(
    (source.match(/\bdisabled\b/gu) ?? []).length >= 4,
    "every connection and member effect in the tour must stay disabled",
  );

  for (const falseClaim of [
    "✓ Conectado",
    "authenticated · healthy",
    "válida 21d",
    "válida 13d",
    'StatusDot status="Ready"',
    "conectado com sucesso",
  ]) {
    assert.equal(source.includes(falseClaim), false, falseClaim);
  }
  assert.doesNotMatch(source, /\bconnect\(/u);
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
