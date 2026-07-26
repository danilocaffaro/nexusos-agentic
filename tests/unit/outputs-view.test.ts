import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  canSubmitArtifactEditor,
  isCurrentArtifactListRequest,
  OutputsView,
} from "../../app/outputs-view";

test("labels the persistent artifact registry honestly", () => {
  const html = renderToStaticMarkup(
    createElement(OutputsView, {
      workspace: {
        projects: [
          { id: "project-1", name: "Nexus Commerce", status: "active" },
        ],
        workItems: [
          {
            id: "work-0",
            project_id: "project-1",
            ref: "WI-000",
            title: "Earlier item",
            status: "ready",
          },
          {
            id: "work-1",
            project_id: "project-1",
            ref: "WI-001",
            title: "Publish evidence",
            status: "in_progress",
          },
        ],
      },
      initialWorkItemId: "work-1",
      notify: () => undefined,
    }),
  );

  assert.match(html, /ARTIFACT REGISTRY · REAL/);
  assert.match(html, /REAL · LOCAL D1/);
  assert.match(html, /sem dependência de GitHub ou storage pago/i);
  assert.match(html, /WI-001/);
  assert.match(html, /value="work-1" selected=""/);
  assert.doesNotMatch(html, /284|92% linked|checkout-service production/);
});

test("only the latest artifact list request may update selection", () => {
  assert.equal(isCurrentArtifactListRequest(4, 4), true);
  assert.equal(isCurrentArtifactListRequest(3, 4), false);
});

test("a conflicted artifact editor is structurally blocked", () => {
  assert.equal(
    canSubmitArtifactEditor({
      saving: false,
      conflicted: true,
      content: "# Stale draft",
      title: "Output",
      requiresTitle: false,
    }),
    false,
  );
  assert.equal(
    canSubmitArtifactEditor({
      saving: false,
      conflicted: false,
      content: "# Current draft",
      title: "Output",
      requiresTitle: false,
    }),
    true,
  );
});
