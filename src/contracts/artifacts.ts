export const ARTIFACT_MEDIA_TYPE = "text/markdown" as const;
export const MAX_ARTIFACT_CONTENT_BYTES = 256 * 1024;

export type ArtifactMediaType = typeof ARTIFACT_MEDIA_TYPE;

export type ArtifactVersionSummary = {
  versionNumber: number;
  contentHash: string;
  byteSize: number;
  note: string;
  createdBy: {
    id: string;
    displayName: string;
  };
  createdAt: string;
};

export type ArtifactSummary = {
  id: string;
  projectId: string;
  projectName: string;
  workItemId: string;
  workItemRef: string;
  workItemTitle: string;
  title: string;
  mediaType: ArtifactMediaType;
  currentVersion: number;
  currentContentHash: string;
  currentByteSize: number;
  createdBy: {
    id: string;
    displayName: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type ArtifactDetail = ArtifactSummary & {
  versions: ArtifactVersionSummary[];
};

export type ArtifactVersionContent = ArtifactVersionSummary & {
  artifactId: string;
  title: string;
  mediaType: ArtifactMediaType;
  content: string | null;
  erasedAt: string | null;
};

export type ArtifactErasureImpact = {
  artifactId: string;
  versionNumber: number;
  projectId: string;
  contentHash: string;
  byteSize: number;
  referenceCount: number;
  livePayloadCount: number;
  versions: Array<{
    artifactId: string;
    artifactTitle: string;
    versionNumber: number;
    projectId: string;
    workItemId: string;
    workItemRef: string;
  }>;
};

export type ArtifactReviewVerdict = "approved" | "changes_requested";
export type ArtifactReviewReasonCode =
  | "accurate"
  | "complete"
  | "needs_correction"
  | "needs_evidence"
  | "outdated";

export type ArtifactReview = {
  id: string;
  artifactId: string;
  artifactVersionId: string;
  versionNumber: number;
  contentHash: string;
  byteSize: number;
  verdict: ArtifactReviewVerdict;
  reasonCode: ArtifactReviewReasonCode;
  reviewer: {
    id: string;
    displayName: string;
  };
  selfReviewPolicy?: "solo_owner_ack";
  status: "active" | "superseded";
  supersedesReviewId?: string;
  supersededBy?: {
    id: string;
    displayName: string;
  };
  createdAt: string;
  supersededAt?: string;
};

export type ArtifactReviewState = {
  artifactId: string;
  versionNumber: number;
  contentHash: string;
  erasedAt?: string;
  selfReviewApproval:
    | "not_self"
    | "solo_owner_ack"
    | "independent_required"
    | "owner_role_required";
  myActiveReviewId?: string;
  reviews: ArtifactReview[];
};

export type ArtifactSupersessionReasonCode =
  | "replaced_by_revision"
  | "duplicate_output"
  | "scope_moved";

export type ArtifactSupersessionRetractionReasonCode =
  | "declared_in_error"
  | "no_longer_accurate";

export type ArtifactSupersessionEndpoint = {
  artifactId: string;
  title: string;
  projectId: string;
  projectName: string;
  projectStatus: "active" | "paused" | "archived";
  pinnedVersionNumber: number;
  currentVersionNumber: number;
  contentHash: string;
  byteSize: number;
  contentAvailable: boolean;
  staleHead: boolean;
};

export type ArtifactSupersession = {
  id: string;
  source: ArtifactSupersessionEndpoint;
  target: ArtifactSupersessionEndpoint;
  reasonCode: ArtifactSupersessionReasonCode;
  status: "active" | "retracted";
  declaredBy: {
    id: string;
    displayName: string;
  };
  declaredAt: string;
  retractionReasonCode?: ArtifactSupersessionRetractionReasonCode;
  retractedBy?: {
    id: string;
    displayName: string;
  };
  retractedAt?: string;
};

export type ArtifactSupersessionCandidate = {
  artifactId: string;
  title: string;
  projectId: string;
  projectName: string;
  projectStatus: "active" | "paused" | "archived";
  currentVersionNumber: number;
  contentHash: string;
  byteSize: number;
  contentAvailable: boolean;
};

export type ArtifactSupersessionState = {
  artifactId: string;
  canGovern: boolean;
  active?: ArtifactSupersession;
  inbound: ArtifactSupersession[];
  inboundTruncated: boolean;
  history: ArtifactSupersession[];
  historyTruncated: boolean;
  chain: ArtifactSupersession[];
  chainTruncated: boolean;
  candidates: ArtifactSupersessionCandidate[];
  candidatesTruncated: boolean;
};
