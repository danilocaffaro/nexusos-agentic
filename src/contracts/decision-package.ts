import type {
  ActionIntent,
  IntentArtifactEvidence,
  LedgerEntry,
} from "./governance";
import type {
  ArtifactReview,
  ArtifactSupersession,
} from "./artifacts";

export const DECISION_PACKAGE_SPEC_VERSION = 1 as const;
export const MAX_DECISION_PACKAGE_EVIDENCE = 50;
export const MAX_DECISION_PACKAGE_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_DECISION_PACKAGE_REVIEWS_PER_VERSION = 20;
export const MAX_DECISION_PACKAGE_SUPERSESSIONS = 100;
export const MAX_DECISION_PACKAGE_LEDGER_ENTRIES = 300;

export type DecisionPackageContentIntegrity =
  | "verified"
  | "failed"
  | "erased"
  | "omitted_size_bound"
  | "metadata_only";

export type DecisionPackageIntent = ActionIntent & {
  organizationName: string;
  projectName: string;
  proposerDisplayName: string;
};

export type DecisionPackageApproval = ActionIntent["approvals"][number] & {
  actorDisplayName: string;
};

export type DecisionPackageEvidence = IntentArtifactEvidence & {
  projectName: string;
  workItemTitle: string;
  artifactVersionNote: string;
  producer: {
    id: string;
    displayName: string;
  };
  versionCreatedAt: string;
  versionContentHash: string;
  versionByteSize: number;
  content: string | null;
  contentSelected: boolean;
  payloadErasedAt?: string;
  actualBodyBytes: number;
  reviews: ArtifactReview[];
  reviewsTotal: number;
  reviewsTruncated: boolean;
  reviewsShownWithEarlierEvidence?: boolean;
  supersessions: ArtifactSupersession[];
  supersessionsShownWithEarlierEvidence?: boolean;
};

export type DecisionPackageLedgerEntry = LedgerEntry & {
  actorDisplayName: string;
  hashValid: boolean;
};

export type DecisionPackageSnapshot = {
  intent: DecisionPackageIntent;
  approvals: DecisionPackageApproval[];
  evidence: DecisionPackageEvidence[];
  supersessionsTotal: number;
  supersessionsTruncated: boolean;
  ledger: Array<Omit<DecisionPackageLedgerEntry, "hashValid">>;
  ledgerTotal: number;
  ledgerTruncated: boolean;
};

export type DecisionPackageEvidencePreview = {
  id: string;
  artifactId: string;
  artifactTitle: string;
  versionNumber: number;
  relation: IntentArtifactEvidence["relation"];
  status: IntentArtifactEvidence["status"];
  contentHash: string;
  byteSize: number;
  contentIntegrity: DecisionPackageContentIntegrity;
  reviews: number;
  reviewsTruncated: boolean;
  supersessions: number;
};

export type DecisionPackagePreview = {
  specVersion: typeof DECISION_PACKAGE_SPEC_VERSION;
  intentId: string;
  intentStatus: ActionIntent["status"];
  packageId: string;
  representationHash: string;
  byteSize: number;
  approvals: number;
  evidence: DecisionPackageEvidencePreview[];
  reviews: number;
  supersessions: number;
  supersessionsTotal: number;
  supersessionsTruncated: boolean;
  ledgerEntries: number;
  ledgerEntriesTotal: number;
  ledgerEntriesTruncated: boolean;
  ledgerEntryHashesValid: boolean;
  erasedBodies: number;
  failedBodies: number;
  omittedBodies: number;
};

export type RenderedDecisionPackage = {
  preview: DecisionPackagePreview;
  markdown: string;
  bytes: Uint8Array;
  reprDigestBase64: string;
};
