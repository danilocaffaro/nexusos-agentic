import {
  createAgent,
  createConnection,
  createProject,
  createTeam,
  WorkspaceRepositoryError,
} from "@/src/adapters/d1/workspace-repository";
import {
  createObjective,
  createWorkItem,
} from "@/src/adapters/d1/work-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export async function POST(
  request: Request,
  context: { params: Promise<{ entity: string }> },
) {
  const { entity } = await context.params;
  return workspaceRoute(
    request,
    async (identity, input) => {
      switch (entity) {
        case "projects":
          return createProject(identity, input);
        case "teams":
          return createTeam(identity, input);
        case "connections":
          return createConnection(identity, input);
        case "agents":
          return createAgent(identity, input);
        case "objectives":
          return createObjective(identity, input);
        case "work-items":
          return createWorkItem(identity, input);
        default:
          throw new WorkspaceRepositoryError("unknown_entity", 404);
      }
    },
    201,
  );
}
