import { appendArtifactVersion } from "@/src/adapters/d1/artifact-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export async function POST(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await context.params;
  return workspaceRoute(
    request,
    (identity, input) => appendArtifactVersion(identity, artifactId, input),
    201,
  );
}
