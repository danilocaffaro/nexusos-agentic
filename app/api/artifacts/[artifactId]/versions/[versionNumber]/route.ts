import { getArtifactVersion } from "@/src/adapters/d1/artifact-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ artifactId: string; versionNumber: string }>;
  },
) {
  const { artifactId, versionNumber } = await context.params;
  const parsedVersion = Number(versionNumber);
  if (!Number.isSafeInteger(parsedVersion) || parsedVersion < 1) {
    return workspaceRoute(request, async () => {
      throw new WorkspaceRepositoryError("invalid_artifact_version", 400);
    });
  }
  return workspaceRoute(request, (identity) =>
    getArtifactVersion(identity, artifactId, parsedVersion),
  );
}
