import { listWorkspace } from "@/src/adapters/d1/workspace-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return workspaceRoute(request, (identity) => listWorkspace(identity));
}
