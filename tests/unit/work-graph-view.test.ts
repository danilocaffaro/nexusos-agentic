import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProjectWorkGraph,
  type WorkGraphItem,
  type WorkGraphObjective,
} from "../../app/work-graph-view";

const objective: WorkGraphObjective = {
  id: "objective-1",
  project_id: "project-1",
  ref: "OBJ-A11CE001",
  title: "Ship a persistent work graph",
  description: "Prove the local source of truth.",
  status: "active",
  priority: "p0",
  version: 2,
};

const workItem: WorkGraphItem = {
  id: "work-1",
  project_id: "project-1",
  objective_id: objective.id,
  ref: "WI-A11CE001",
  kind: "story",
  title: "Render the real board",
  description: "",
  status: "in_progress",
  priority: "p1",
  assignee_id: null,
  external_ref: null,
  version: 3,
};

test("renders persisted objectives and work items as real capability", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectWorkGraph, {
      projectId: "project-1",
      objectives: [objective],
      workItems: [workItem],
      onChanged: () => undefined,
      onOpenOutputs: () => undefined,
      notify: () => undefined,
    }),
  );

  assert.match(html, /WORK GRAPH · REAL/);
  assert.match(html, /OBJ-A11CE001/);
  assert.match(html, /WI-A11CE001/);
  assert.match(html, /Outputs/);
  assert.match(html, /GitHub Issues será um adapter governado/);
  assert.doesNotMatch(html, /WorkItem · roadmap/);
});
