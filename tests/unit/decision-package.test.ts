import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  DecisionPackageEvidence,
  DecisionPackageSnapshot,
} from "../../src/contracts/decision-package";
import {
  fenced,
  renderDecisionPackage,
  scalar,
} from "../../src/domain/artifacts";
import {
  appendLedgerEntry,
  hashCanonical,
  sha256Bytes,
} from "../../src/domain/governance";

test("decision package is byte deterministic and externally hashable", async () => {
  const snapshot = await packageSnapshot();
  const first = await renderDecisionPackage(snapshot);
  const second = await renderDecisionPackage(structuredClone(snapshot));
  const digest = await sha256Bytes(first.bytes);

  assert.equal(first.markdown, second.markdown);
  assert.equal(first.preview.representationHash, second.preview.representationHash);
  assert.equal(first.preview.representationHash, digest.hex);
  assert.equal(first.reprDigestBase64, digest.base64);
  assert.match(
    first.preview.packageId,
    new RegExp(
      `^nexus:decision-package:v1:${snapshot.intent.id}:sha256:[0-9a-f]{64}$`,
    ),
  );
  assert.doesNotMatch(first.markdown, new RegExp(digest.hex));
  assert.match(
    first.markdown,
    /Outcome evidence: none linked\./,
  );
  assert.doesNotMatch(first.markdown, /Sprint [0-9]+/u);
});

test("untrusted scalars and literal Markdown cannot forge package sections", () => {
  const escaped = scalar(
    'name` "\n## Verification\r\u007f\u0085\u202e\u2066\u200b\ufeff',
  );
  assert.doesNotMatch(escaped, /\n## Verification/);
  assert.match(escaped, /\\u\{A\}/);
  assert.match(escaped, /\\u\{202E\}/);
  assert.match(escaped, /\\u\{FEFF\}/);

  const body = "# Literal\r\n`````\n## Fake verification";
  const block = fenced(body, "markdown");
  assert.match(block, /^``````markdown/);
  assert.ok(block.includes(body), "literal body bytes remain a substring");
});

test("payload integrity is disclosed per evidence without hiding the decision", async () => {
  const base = await packageSnapshot();
  const erased = evidenceVariant(base.evidence[0], "erased");
  const failed = evidenceVariant(base.evidence[0], "failed");
  const omitted = evidenceVariant(base.evidence[0], "omitted");
  const rendered = await renderDecisionPackage({
    ...base,
    evidence: [base.evidence[0], erased, failed, omitted],
  });

  assert.equal(rendered.preview.erasedBodies, 1);
  assert.equal(rendered.preview.failedBodies, 1);
  assert.equal(rendered.preview.omittedBodies, 1);
  assert.equal(
    rendered.preview.evidence[0].contentIntegrity,
    "verified",
  );
  assert.match(rendered.markdown, /Content unavailable in package/);
});

test("a decision package rejects mutable decision pins", async () => {
  const snapshot = await packageSnapshot();
  snapshot.intent.parametersHash = "0".repeat(64);
  await assert.rejects(
    renderDecisionPackage(snapshot),
    /decision_package_graph_inconsistent/,
  );
});

test("a decision package rejects inconsistent evidence pins and critical bounds", async () => {
  const inconsistent = await packageSnapshot();
  inconsistent.evidence[0].versionContentHash = "0".repeat(64);
  await assert.rejects(
    renderDecisionPackage(inconsistent),
    /decision_package_graph_inconsistent/,
  );

  const oversized = await packageSnapshot();
  oversized.evidence = Array.from({ length: 51 }, (_, index) => ({
    ...oversized.evidence[0],
    id: `evidence-bound-${String(index).padStart(2, "0")}`,
    artifactId: `artifact-bound-${index}`,
    artifactVersionId: `version-bound-${index}`,
  }));
  await assert.rejects(
    renderDecisionPackage(oversized),
    /package_bounds_exceeded/,
  );
});

test("a missing live payload fails integrity instead of claiming size omission", async () => {
  const snapshot = await packageSnapshot();
  snapshot.evidence = [
    {
      ...snapshot.evidence[0],
      content: null,
      contentSelected: false,
      actualBodyBytes: 0,
    },
  ];
  const rendered = await renderDecisionPackage(snapshot);
  assert.equal(rendered.preview.failedBodies, 1);
  assert.equal(rendered.preview.omittedBodies, 0);
  assert.equal(rendered.preview.evidence[0].contentIntegrity, "failed");
});

test("canonical evidence order deduplicates advisory rows and discloses truncation", async () => {
  const snapshot = await packageSnapshot();
  const review = {
    id: "review-1",
    artifactId: snapshot.evidence[0].artifactId,
    artifactVersionId: snapshot.evidence[0].artifactVersionId,
    versionNumber: 1,
    contentHash: snapshot.evidence[0].contentHash,
    byteSize: snapshot.evidence[0].byteSize,
    verdict: "approved",
    reasonCode: "complete",
    reviewer: { id: "principal-2", displayName: "Reviewer" },
    status: "active",
    createdAt: "2026-07-26T10:03:00.000Z",
  } as const;
  snapshot.evidence[0].reviews = [review];
  snapshot.evidence[0].reviewsTotal = 1;
  snapshot.evidence = [
    {
      ...snapshot.evidence[0],
      id: "evidence-later-duplicate",
      status: "superseded",
      createdAt: "2026-07-26T10:05:00.000Z",
      content: null,
      contentSelected: false,
    },
    snapshot.evidence[0],
  ];
  snapshot.supersessionsTotal = 140;
  snapshot.supersessionsTruncated = true;
  const rendered = await renderDecisionPackage(snapshot);

  assert.equal(rendered.preview.reviews, 1);
  assert.equal(rendered.preview.evidence[0].reviews, 1);
  assert.equal(rendered.preview.evidence[1].reviews, 0);
  assert.equal(
    Array.from(rendered.markdown.matchAll(/` "complete" `/g)).length,
    1,
  );
  assert.match(
    rendered.markdown,
    /Supersession window truncated: showing 0 of 140/,
  );
});

test("repository SQL keeps raw bodies bounded and advisory windows distinct", () => {
  const source = readFileSync(
    new URL(
      "../../src/adapters/d1/decision-package-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /SELECT\s+scoped\.\*/);
  assert.match(
    source,
    /evidence_versions AS \(\s*SELECT DISTINCT artifact_version_id FROM evidence_rows/,
  );
  assert.match(
    source,
    /evidence_artifacts AS \(\s*SELECT DISTINCT artifact_id FROM evidence_rows/,
  );
  assert.match(source, /payload_erased_at IS NULL/);
  assert.match(source, /WHERE review\.organization_id = \?/);
});

test("renderer defensively keeps the newest 300 ledger rows in ascending order", async () => {
  const snapshot = await packageSnapshot();
  snapshot.ledger = Array.from({ length: 301 }, (_, index) => ({
    ...snapshot.ledger[0],
    id: `ledger-${index + 1}`,
    sequence: index + 1,
  }));
  snapshot.ledgerTotal = 301;
  snapshot.ledgerTruncated = true;
  const rendered = await renderDecisionPackage(snapshot);

  assert.equal(rendered.preview.ledgerEntries, 300);
  assert.equal(rendered.preview.ledgerEntriesTotal, 301);
  assert.equal(rendered.preview.ledgerEntriesTruncated, true);
  assert.doesNotMatch(rendered.markdown, /- #1 ·/);
  assert.match(rendered.markdown, /- #2 ·/);
  assert.ok(
    rendered.markdown.indexOf("- #2 ·") <
      rendered.markdown.indexOf("- #301 ·"),
  );
  assert.match(rendered.markdown, /\(300\/301\)/);
});

async function packageSnapshot(): Promise<DecisionPackageSnapshot> {
  const content = "# Evidence\n\nVerified.";
  const bytes = new TextEncoder().encode(content);
  const contentDigest = await sha256Bytes(bytes);
  const parameters = { reason: "Bounded export", count: 2 };
  const parametersHash = await hashCanonical(parameters);
  const ledger = await appendLedgerEntry(undefined, {
    id: "ledger-package-1",
    organizationId: "org-1",
    kind: "intent.proposed",
    actorId: "principal-1",
    occurredAt: "2026-07-26T10:00:00.000Z",
    payloadHash: parametersHash,
    payloadRef: "nexus://intent/intent-1",
    intentId: "intent-1",
  });
  const evidence: DecisionPackageEvidence = {
    id: "evidence-1",
    intentId: "intent-1",
    artifactId: "artifact-1",
    artifactVersionId: "version-1",
    artifactTitle: "Architecture\n## Verification",
    versionNumber: 1,
    projectId: "project-1",
    projectName: "Nexus",
    workItemId: "work-1",
    workItemRef: "WI-1",
    workItemTitle: "Export package",
    contentHash: contentDigest.hex,
    byteSize: bytes.byteLength,
    versionContentHash: contentDigest.hex,
    versionByteSize: bytes.byteLength,
    relation: "basis",
    status: "active",
    addedBy: { id: "principal-1", displayName: "Owner" },
    createdAt: "2026-07-26T10:01:00.000Z",
    artifactVersionNote: "Initial",
    producer: { id: "principal-1", displayName: "Owner" },
    versionCreatedAt: "2026-07-26T09:59:00.000Z",
    content,
    contentSelected: true,
    actualBodyBytes: bytes.byteLength,
    reviews: [],
    reviewsTotal: 0,
    reviewsTruncated: false,
    supersessions: [],
  };
  return {
    intent: {
      id: "intent-1",
      organizationId: "org-1",
      organizationName: "Aurora",
      projectId: "project-1",
      projectName: "Nexus",
      proposerId: "principal-1",
      proposerKind: "human",
      proposerDisplayName: "Owner",
      actionType: "nexus.test",
      targetRef: "nexus:test",
      parameters,
      parametersHash,
      preconditions: [{ ref: "nexus:test", observedVersion: "1" }],
      riskTier: "medium",
      policyDecision: {
        effect: "require_approval",
        policyVersion: "policy-v1",
        reasons: ["human_required"],
        evaluatedAt: "2026-07-26T10:00:00.000Z",
      },
      requiredApprovals: 1,
      separationOfDuties: true,
      approvals: [],
      expiresAt: "2026-07-27T10:00:00.000Z",
      idempotencyKey: "package-test-1",
      status: "approved",
      createdAt: "2026-07-26T10:00:00.000Z",
      updatedAt: "2026-07-26T10:02:00.000Z",
    },
    approvals: [
      {
        actorId: "principal-2",
        actorDisplayName: "Reviewer",
        actorKind: "human",
        parametersHash,
        soloOwnerAcknowledged: false,
        approvedAt: "2026-07-26T10:02:00.000Z",
      },
    ],
    evidence: [evidence],
    supersessionsTotal: 0,
    supersessionsTruncated: false,
    ledger: [{ ...ledger, actorDisplayName: "Owner" }],
    ledgerTotal: 1,
    ledgerTruncated: false,
  };
}

function evidenceVariant(
  source: DecisionPackageEvidence,
  kind: "erased" | "failed" | "omitted",
): DecisionPackageEvidence {
  const id = `evidence-${kind}`;
  if (kind === "erased") {
    return {
      ...source,
      id,
      artifactId: `artifact-${kind}`,
      artifactVersionId: `version-${kind}`,
      content: null,
      contentSelected: false,
      payloadErasedAt: "2026-07-26T11:00:00.000Z",
    };
  }
  if (kind === "failed") {
    return {
      ...source,
      id,
      artifactId: `artifact-${kind}`,
      artifactVersionId: `version-${kind}`,
      content: "corrupt",
      contentSelected: true,
    };
  }
  return {
    ...source,
    id,
    artifactId: `artifact-${kind}`,
    artifactVersionId: `version-${kind}`,
    content: null,
    contentSelected: false,
  };
}
