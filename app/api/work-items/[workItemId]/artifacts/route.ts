import {
  createArtifact,
  listArtifactsForWorkItem,
} from "@/src/adapters/d1/artifact-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export async function GET(
  request: Request,
  context: { params: Promise<{ workItemId: string }> },
) {
  const { workItemId } = await context.params;
  return workspaceRoute(request, (identity) =>
    listArtifactsForWorkItem(identity, workItemId),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workItemId: string }> },
) {
  const { workItemId } = await context.params;
  return workspaceRoute(
    request,
    (identity, input) => createArtifact(identity, workItemId, input),
    201,
  );
}
