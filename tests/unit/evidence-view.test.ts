import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntentEvidencePanel } from "../../app/intent-evidence-panel";

test("labels decision evidence as real metadata-only lineage", () => {
  const html = renderToStaticMarkup(
    createElement(IntentEvidencePanel, {
      intentId: "intent-1",
      intentStatus: "proposed",
      onOpenArtifact: () => undefined,
      onLedgerChanged: () => undefined,
      notify: () => undefined,
    }),
  );
  assert.match(html, /EVIDENCE LINEAGE · REAL/);
  assert.match(html, /Apenas IDs, hash e metadados imutáveis/);
  assert.match(html, /Open evidence set/);
  assert.match(html, /Vincular basis/);
  assert.doesNotMatch(html, /Vincular outcome/);
});

test("evidence UI has no direct payload or deletion route", () => {
  const source = readFileSync(
    new URL("../../app/intent-evidence-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /relation:\s*"basis"/);
  assert.match(source, /Payload apagado · prova preservada/);
  assert.doesNotMatch(source, /method:\s*"DELETE"/);
  assert.doesNotMatch(source, /bodyText|payloadContent|artifactContent/);
});
