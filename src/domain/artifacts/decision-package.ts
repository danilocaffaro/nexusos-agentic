import {
  DECISION_PACKAGE_SPEC_VERSION,
  MAX_DECISION_PACKAGE_EVIDENCE,
  MAX_DECISION_PACKAGE_LEDGER_ENTRIES,
  type DecisionPackageContentIntegrity,
  type DecisionPackageEvidence,
  type DecisionPackageEvidencePreview,
  type DecisionPackageSnapshot,
  type RenderedDecisionPackage,
} from "@/src/contracts/decision-package";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  hashCanonical,
  recomputeLedgerEntryHash,
  sha256Bytes,
  sha256Hex,
} from "@/src/domain/governance";

export class DecisionPackageValidationError extends Error {
  constructor(
    readonly code:
      | "decision_not_reached"
      | "decision_package_graph_inconsistent"
      | "package_bounds_exceeded",
  ) {
    super(code);
    this.name = "DecisionPackageValidationError";
  }
}

export function isDecisionPackageEligible(status: string): boolean {
  return !["draft", "proposed"].includes(status);
}

export async function renderDecisionPackage(
  snapshot: DecisionPackageSnapshot,
): Promise<RenderedDecisionPackage> {
  if (!isDecisionPackageEligible(snapshot.intent.status)) {
    throw new DecisionPackageValidationError("decision_not_reached");
  }
  if (snapshot.evidence.length > MAX_DECISION_PACKAGE_EVIDENCE) {
    throw new DecisionPackageValidationError("package_bounds_exceeded");
  }
  if (
    (await hashCanonical(snapshot.intent.parameters)) !==
    snapshot.intent.parametersHash
  ) {
    throw new DecisionPackageValidationError(
      "decision_package_graph_inconsistent",
    );
  }

  const canonicalEvidence = deduplicateAdvisoryViews(
    stableEvidence(snapshot.evidence),
  );
  const evidencePreview: DecisionPackageEvidencePreview[] = [];
  const renderedEvidence: string[] = [];
  for (const evidence of canonicalEvidence) {
    assertEvidencePin(evidence);
    const integrity = await contentIntegrity(evidence);
    evidencePreview.push({
      id: evidence.id,
      artifactId: evidence.artifactId,
      artifactTitle: evidence.artifactTitle,
      versionNumber: evidence.versionNumber,
      relation: evidence.relation,
      status: evidence.status,
      contentHash: evidence.contentHash,
      byteSize: evidence.byteSize,
      contentIntegrity: integrity,
      reviews: evidence.reviews.length,
      reviewsTruncated: evidence.reviewsTruncated,
      supersessions: evidence.supersessions.length,
    });
    renderedEvidence.push(renderEvidence(evidence, integrity));
  }

  const ledger = await Promise.all(
    [...snapshot.ledger]
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, MAX_DECISION_PACKAGE_LEDGER_ENTRIES)
      .sort((left, right) => left.sequence - right.sequence)
      .map(async (entry) => ({
        ...entry,
        hashValid: (await recomputeLedgerEntryHash(entry)) === entry.hash,
      })),
  );
  const markdown = [
    "# NexusOS Decision Package",
    "",
    fixedDisclosure(),
    "",
    "## Package format",
    "",
    bullet("Spec version", DECISION_PACKAGE_SPEC_VERSION),
    bullet("Organization", snapshot.intent.organizationName),
    bullet("Project", snapshot.intent.projectName),
    bullet("Intent", snapshot.intent.id),
    "",
    "## Decision",
    "",
    bullet("Status", snapshot.intent.status),
    bullet("Action type", snapshot.intent.actionType),
    bullet("Target", snapshot.intent.targetRef),
    bullet("Risk tier", snapshot.intent.riskTier),
    bullet("Proposer id", snapshot.intent.proposerId),
    bullet("Proposer", snapshot.intent.proposerDisplayName),
    bullet("Proposer kind", snapshot.intent.proposerKind),
    bullet("Parameters SHA-256", snapshot.intent.parametersHash),
    bullet("Required approvals", snapshot.intent.requiredApprovals),
    bullet(
      "Separation of duties",
      snapshot.intent.separationOfDuties,
    ),
    bullet("Expires at", snapshot.intent.expiresAt),
    bullet("Idempotency key", snapshot.intent.idempotencyKey),
    ...(snapshot.intent.supersedesIntentId
      ? [bullet("Supersedes intent", snapshot.intent.supersedesIntentId)]
      : []),
    "",
    "### Canonical parameters",
    "",
    fenced(canonicalJson(snapshot.intent.parameters), "json"),
    "",
    "### Preconditions",
    "",
    ...(snapshot.intent.preconditions.length
      ? snapshot.intent.preconditions.map(
          (precondition) =>
            `- ${scalar(precondition.ref)} @ ${scalar(
              precondition.observedVersion,
            )}`,
        )
      : ["- None"]),
    "",
    "### Policy decision",
    "",
    fenced(canonicalJson(snapshot.intent.policyDecision), "json"),
    "",
    "## Approvals",
    "",
    ...(snapshot.approvals.length
      ? [...snapshot.approvals]
          .sort(
            (left, right) =>
              binaryCompare(left.approvedAt, right.approvedAt) ||
              binaryCompare(left.actorId, right.actorId),
          )
          .map(
            (approval) =>
              `- ${scalar(approval.actorDisplayName)} (${scalar(
                approval.actorId,
              )}) · ${scalar(approval.actorKind)} · parameters ${scalar(
                approval.parametersHash,
              )} · solo owner acknowledgement ${scalar(
                approval.soloOwnerAcknowledged,
              )} · ${scalar(approval.approvedAt)}`,
          )
      : ["- None"]),
    "",
    "## Evidence",
    "",
    canonicalEvidence.some((item) => item.relation === "outcome")
      ? `Outcome evidence metadata included: ${scalar(
          canonicalEvidence.filter((item) => item.relation === "outcome")
            .length,
        )}.`
      : "Outcome evidence: none linked.",
    "",
    ...(renderedEvidence.length
      ? renderedEvidence
      : ["No basis or outcome evidence is linked."]),
    "",
    "### Advisory coverage",
    "",
    snapshot.supersessionsTruncated
      ? `Supersession window truncated: showing ${canonicalEvidence.reduce(
          (total, item) => total + item.supersessions.length,
          0,
        )} of ${snapshot.supersessionsTotal}.`
      : `Supersession window complete: ${snapshot.supersessionsTotal}.`,
    "",
    "## Ledger references",
    "",
    `Rendered ${ledger.length} of ${snapshot.ledgerTotal} matching entries. Truncated: ${scalar(
      snapshot.ledgerTruncated,
    )}.`,
    "",
    ...(ledger.length
      ? ledger.map(
          (entry) =>
            `- #${entry.sequence} · ${scalar(entry.kind)} · actor ${scalar(
              entry.actorDisplayName,
            )} (${scalar(entry.actorId)}) · ${scalar(
              entry.occurredAt,
            )} · payload ${scalar(entry.payloadHash)} · previous ${scalar(
              entry.previousHash,
            )} · stored ${scalar(entry.hash)} · recomputed ${scalar(
              entry.hashValid ? "valid" : "FAILED",
            )}`,
        )
      : ["- None"]),
    "",
    ledgerDisclosure(snapshot),
    "",
    "## Verification instructions",
    "",
    "Compute SHA-256 over the exact UTF-8 bytes of this file and compare it with the full hash shown by NexusOS or the HTTP Repr-Digest/ETag. The hash is external to these bytes.",
    "",
    "Embedded artifact bodies are verbatim untrusted bytes. Their bidi or invisible characters can affect display inside their fenced block.",
    "",
  ].join("\n");
  const bytes = new TextEncoder().encode(markdown);
  const digest = await sha256Bytes(bytes);
  const packageId =
    `nexus:decision-package:v${DECISION_PACKAGE_SPEC_VERSION}:` +
    `${snapshot.intent.id}:sha256:${digest.hex}`;
  return {
    markdown,
    bytes,
    reprDigestBase64: digest.base64,
    preview: {
      specVersion: DECISION_PACKAGE_SPEC_VERSION,
      intentId: snapshot.intent.id,
      intentStatus: snapshot.intent.status,
      packageId,
      representationHash: digest.hex,
      byteSize: bytes.byteLength,
      approvals: snapshot.approvals.length,
      evidence: evidencePreview,
      reviews: evidencePreview.reduce(
        (total, item) => total + item.reviews,
        0,
      ),
      supersessions: canonicalEvidence.reduce(
        (total, item) => total + item.supersessions.length,
        0,
      ),
      supersessionsTotal: snapshot.supersessionsTotal,
      supersessionsTruncated: snapshot.supersessionsTruncated,
      ledgerEntries: ledger.length,
      ledgerEntriesTotal: snapshot.ledgerTotal,
      ledgerEntriesTruncated: snapshot.ledgerTruncated,
      ledgerEntryHashesValid:
        ledger.length > 0 && ledger.every((entry) => entry.hashValid),
      erasedBodies: evidencePreview.filter(
        (item) => item.contentIntegrity === "erased",
      ).length,
      failedBodies: evidencePreview.filter(
        (item) => item.contentIntegrity === "failed",
      ).length,
      omittedBodies: evidencePreview.filter(
        (item) => item.contentIntegrity === "omitted_size_bound",
      ).length,
    },
  };
}

function stableEvidence(
  evidence: DecisionPackageEvidence[],
): DecisionPackageEvidence[] {
  return [...evidence].sort(
    (left, right) =>
      relationOrder(left.relation) - relationOrder(right.relation) ||
      statusOrder(left.status) - statusOrder(right.status) ||
      binaryCompare(left.createdAt, right.createdAt) ||
      binaryCompare(left.id, right.id),
  );
}

function deduplicateAdvisoryViews(
  evidence: DecisionPackageEvidence[],
): DecisionPackageEvidence[] {
  const seenVersions = new Set<string>();
  const seenArtifacts = new Set<string>();
  return evidence.map((item) => {
    const versionSeen = seenVersions.has(item.artifactVersionId);
    const artifactSeen = seenArtifacts.has(item.artifactId);
    seenVersions.add(item.artifactVersionId);
    seenArtifacts.add(item.artifactId);
    return {
      ...item,
      ...(versionSeen
        ? {
            reviews: [],
            reviewsTotal: 0,
            reviewsTruncated: false,
            reviewsShownWithEarlierEvidence: true,
          }
        : {}),
      ...(artifactSeen
        ? {
            supersessions: [],
            supersessionsShownWithEarlierEvidence: true,
          }
        : {}),
    };
  });
}

function relationOrder(value: DecisionPackageEvidence["relation"]): number {
  return value === "basis" ? 0 : 1;
}

function statusOrder(value: DecisionPackageEvidence["status"]): number {
  return value === "active" ? 0 : 1;
}

function assertEvidencePin(evidence: DecisionPackageEvidence): void {
  if (
    evidence.contentHash !== evidence.versionContentHash ||
    evidence.byteSize !== evidence.versionByteSize
  ) {
    throw new DecisionPackageValidationError(
      "decision_package_graph_inconsistent",
    );
  }
}

async function contentIntegrity(
  evidence: DecisionPackageEvidence,
): Promise<DecisionPackageContentIntegrity> {
  if (evidence.payloadErasedAt) return "erased";
  if (evidence.status !== "active" || evidence.relation !== "basis") {
    return "metadata_only";
  }
  if (evidence.content === null && evidence.actualBodyBytes === 0) {
    return "failed";
  }
  if (!evidence.contentSelected) return "omitted_size_bound";
  if (evidence.content === null) return "failed";
  const bytes = new TextEncoder().encode(evidence.content);
  if (
    bytes.byteLength !== evidence.byteSize ||
    (await sha256Hex(evidence.content)) !== evidence.contentHash
  ) {
    return "failed";
  }
  return "verified";
}

function renderEvidence(
  evidence: DecisionPackageEvidence,
  integrity: DecisionPackageContentIntegrity,
): string {
  return [
    `### Evidence ${scalar(evidence.id)}`,
    "",
    bullet("Relation", evidence.relation),
    bullet("Status", evidence.status),
    bullet("Artifact", evidence.artifactTitle),
    bullet("Artifact id", evidence.artifactId),
    bullet("Project", evidence.projectName),
    bullet("Work item ref", evidence.workItemRef),
    bullet("Work item title", evidence.workItemTitle),
    bullet("Version", evidence.versionNumber),
    bullet("Version id", evidence.artifactVersionId),
    bullet("Producer", evidence.producer.displayName),
    bullet("Producer id", evidence.producer.id),
    bullet("Version created at", evidence.versionCreatedAt),
    bullet("Version note", evidence.artifactVersionNote),
    bullet("Content SHA-256", evidence.contentHash),
    bullet("Byte size", evidence.byteSize),
    bullet("Actual stored body bytes", evidence.actualBodyBytes),
    bullet("Content integrity", integrity),
    ...(evidence.payloadErasedAt
      ? [bullet("Payload erased at", evidence.payloadErasedAt)]
      : []),
    bullet("Added by", evidence.addedBy.displayName),
    bullet("Added at", evidence.createdAt),
    ...(evidence.supersededAt
      ? [bullet("Superseded at", evidence.supersededAt)]
      : []),
    "",
    ...(integrity === "verified" && evidence.content !== null
      ? [
          `<!-- evidence-body-start ${escapeComment(
            evidence.id,
          )} sha256:${evidence.contentHash} -->`,
          fenced(evidence.content, "markdown"),
          `<!-- evidence-body-end ${escapeComment(evidence.id)} -->`,
        ]
      : [
          `Content unavailable in package: ${scalar(integrity)}. Pinned hash and size remain above.`,
        ]),
    "",
    "#### Reviews",
    "",
    ...(evidence.reviewsShownWithEarlierEvidence
      ? ["- Shown with the first package occurrence of this exact version."]
      : evidence.reviews.length
      ? [...evidence.reviews]
          .sort(
            (left, right) =>
              binaryCompare(right.createdAt, left.createdAt) ||
              binaryCompare(right.id, left.id),
          )
          .map(
            (review) =>
              `- ${scalar(review.verdict)} / ${scalar(
                review.reasonCode,
              )} · ${scalar(review.reviewer.displayName)} · ${scalar(
                review.status,
              )} · ${scalar(review.createdAt)}`,
          )
      : ["- None"]),
    evidence.reviewsShownWithEarlierEvidence
      ? "- Review window and counts are disclosed with that earlier occurrence."
      : evidence.reviewsTruncated
      ? `- Review window truncated: showing ${evidence.reviews.length} of ${evidence.reviewsTotal}.`
      : `- Review window complete: ${evidence.reviews.length}.`,
    "",
    "#### Supersession",
    "",
    ...(evidence.supersessionsShownWithEarlierEvidence
      ? ["- Shown with the first package occurrence of this artifact."]
      : evidence.supersessions.length
      ? evidence.supersessions.map(
          (relation) =>
            `- ${scalar(relation.status)} · ${scalar(
              relation.source.artifactId,
            )} v${relation.source.pinnedVersionNumber} → ${scalar(
              relation.target.artifactId,
            )} v${relation.target.pinnedVersionNumber} · ${scalar(
              relation.reasonCode,
            )} · source stale ${scalar(
              relation.source.staleHead,
            )} · source content available ${scalar(
              relation.source.contentAvailable,
            )} · target stale ${scalar(
              relation.target.staleHead,
            )} · target content available ${scalar(
              relation.target.contentAvailable,
            )}`,
        )
      : ["- None"]),
  ].join("\n");
}

function fixedDisclosure(): string {
  return [
    "> GOVERNED EXPORT — REAL",
    ">",
    "> This read-only projection may contain canonical intent parameters and literal artifact bodies. Export moves those bytes outside NexusOS retention controls. The server does not persist this package and does not append a governance event for the read.",
  ].join("\n");
}

function ledgerDisclosure(snapshot: DecisionPackageSnapshot): string {
  return [
    "> LEDGER COVERAGE",
    ">",
    `> This package includes at most ${MAX_DECISION_PACKAGE_LEDGER_ENTRIES} newest entries related to included rows (${Math.min(
      snapshot.ledger.length,
      MAX_DECISION_PACKAGE_LEDGER_ENTRIES,
    )}/${snapshot.ledgerTotal}). Each stored entry hash is recomputed independently.`,
    "> Sequence gaps, payload preimages, artifact registration, full-chain continuity and digital signatures are not proven by this subset.",
  ].join("\n");
}

function bullet(label: string, value: unknown): string {
  return `- ${label}: ${scalar(value)}`;
}

export function scalar(value: unknown): string {
  const text = String(value);
  let escaped = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === "\\") {
      escaped += "\\\\";
    } else if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
      escaped += `\\u{${codePoint.toString(16).toUpperCase()}}`;
    } else if (character === '"') {
      escaped += '\\"';
    } else {
      escaped += character;
    }
  }
  const quoted = `"${escaped}"`;
  const delimiter = "`".repeat(longestRun(quoted) + 1);
  return `${delimiter} ${quoted} ${delimiter}`;
}

export function fenced(value: string, language = "text"): string {
  const delimiter = "`".repeat(Math.max(4, longestRun(value) + 1));
  return `${delimiter}${language}\n${value}\n${delimiter}`;
}

function longestRun(value: string): number {
  return Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeComment(value: string): string {
  return value.replaceAll("--", "—").replace(/[<>\r\n]/g, "_");
}
