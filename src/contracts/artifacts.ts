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
