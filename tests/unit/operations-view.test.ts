import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationsView } from "../../app/operations-view";

const source = readFileSync(
  new URL("../../app/operations-view.tsx", import.meta.url),
  "utf8",
);

const workspace = {
  projects: [{ id: "project-1", name: "Nexus", status: "active" as const }],
  teams: [
    {
      id: "team-1",
      project_id: "project-1",
      name: "Core",
      status: "active" as const,
    },
  ],
  agents: [
    {
      id: "agent-1",
      name: "Aurora",
      role: "Developer",
      model: "claude-opus-5",
      status: "active" as const,
      teamIds: ["team-1"],
    },
  ],
  workItems: [
    {
      id: "work-1",
      project_id: "project-1",
      ref: "WI-001",
      title: "Operação real",
      status: "ready",
    },
  ],
};

test("owner sees a first-class persistent operation form", () => {
  const html = renderToStaticMarkup(
    createElement(OperationsView, {
      workspace,
      currentRole: "owner",
      notify: () => undefined,
      onOpenArtifact: () => undefined,
    }),
  );
  assert.match(html, /OPERATIONS · OWNER-ONLY · PERSISTENTE/);
  assert.match(html, /WI-001 · Operação real/);
  assert.match(html, /claude-opus-5/);
  assert.match(html, /Engine explícita · readonly/);
  assert.match(html, /Nenhuma opção elegível/);
  assert.match(html, /não atualiza resultados automaticamente/i);
});

test("non-owner sees the boundary and triggers no speculative controls", () => {
  const html = renderToStaticMarkup(
    createElement(OperationsView, {
      workspace,
      currentRole: "admin",
      notify: () => undefined,
      onOpenArtifact: () => undefined,
    }),
  );
  assert.match(html, /Acesso owner-only/);
  assert.doesNotMatch(html, /Criar operação/);
});

test("operations UI uses only bounded endpoints and manual refresh", () => {
  assert.match(source, /fetch\("\/api\/operations"/);
  assert.match(source, /fetch\("\/api\/runs\/engine\/options"/);
  assert.match(source, /\/api\/operations\/\$\{operation\.id\}\/publish/);
  assert.doesNotMatch(source, /setInterval|EventSource|WebSocket/);
  assert.doesNotMatch(source, /\/excerpt|\/tools|\/mcp/iu);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("manual retry reuses the immutable pending id and body", () => {
  assert.match(
    source,
    /"idempotency-key": submission\.operationId/u,
  );
  assert.match(source, /body: JSON\.stringify\(submission\.request\)/u);
  assert.match(
    source,
    /onClick=\{\(\) => void submitPending\(pending\)\}/u,
  );
  const retryStart = source.indexOf("const submitPending");
  const retryEnd = source.indexOf("const createOperation", retryStart);
  assert.equal(
    source.slice(retryStart, retryEnd).includes("generateOperationId"),
    false,
  );
});

test("copy stays disabled until an absolute engine path is supplied", () => {
  assert.match(source, /disabled=\{!commandReady\}/u);
  assert.match(source, /isAbsoluteExecutionPath\(executablePath\)/u);
  assert.match(source, /--server \$\{serverOrigin/u);
  assert.match(source, /serverOrigin=\{serverOrigin\}/u);
});
