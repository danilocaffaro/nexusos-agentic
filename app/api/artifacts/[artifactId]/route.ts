import { getArtifact } from "@/src/adapters/d1/artifact-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await context.params;
  return workspaceRoute(request, (identity) =>
    getArtifact(identity, artifactId),
  );
}
