import { setupWorkspace } from "@/src/adapters/d1/workspace-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return workspaceRoute(
    request,
    (identity, input) => setupWorkspace(identity, input),
    201,
  );
}
