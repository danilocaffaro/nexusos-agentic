import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionPackagePanel } from "../../app/decision-package-panel";

test("decision package UI exposes the real governed export only after decision", () => {
  const eligible = renderToStaticMarkup(
    createElement(DecisionPackagePanel, {
      intentId: "intent-decided",
      intentStatus: "succeeded",
      notify: () => undefined,
    }),
  );
  assert.match(eligible, /DECISION PACKAGE · PERSISTENTE/);
  assert.doesNotMatch(eligible, /S5\.B5/u);
  assert.match(eligible, /read-only · owner\/admin/);
  assert.doesNotMatch(eligible, /EVIDENCE SET OPEN/);

  const proposed = renderToStaticMarkup(
    createElement(DecisionPackagePanel, {
      intentId: "intent-proposed",
      intentStatus: "proposed",
      notify: () => undefined,
    }),
  );
  assert.match(proposed, /EVIDENCE SET OPEN/);
  assert.match(proposed, /deixa draft\/proposed/);
});

test("decision package client verifies exact bytes and never executes Markdown", () => {
  const source = readFileSync(
    new URL("../../app/decision-package-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /expectedRepresentationHash/);
  assert.match(source, /crypto\.subtle\.digest/);
  assert.match(source, /decision_package_hash_mismatch/);
  assert.match(source, /<pre>\{literalPreview\}<\/pre>/);
  assert.doesNotMatch(
    source,
    /dangerouslySetInnerHTML|react-markdown|marked\(|markdownToHtml/,
  );
});
