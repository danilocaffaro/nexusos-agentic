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
