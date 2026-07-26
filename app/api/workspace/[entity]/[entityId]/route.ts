import {
  updateAgent,
  updateConnection,
  updateProject,
  updateTeam,
  WorkspaceRepositoryError,
} from "@/src/adapters/d1/workspace-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ entity: string; entityId: string }> },
) {
  const { entity, entityId } = await context.params;
  return workspaceRoute(request, async (identity, input) => {
    switch (entity) {
      case "projects":
        return updateProject(identity, entityId, input);
      case "teams":
        return updateTeam(identity, entityId, input);
      case "connections":
        return updateConnection(identity, entityId, input);
      case "agents":
        return updateAgent(identity, entityId, input);
      default:
        throw new WorkspaceRepositoryError("unknown_entity", 404);
    }
  });
}
