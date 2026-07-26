import {
  releasePresenceSession,
  updatePresenceSession,
} from "@/src/adapters/d1/presence-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return workspaceRoute(request, (identity, input) =>
    updatePresenceSession(identity, input),
  );
}

export async function DELETE(request: Request) {
  return workspaceRoute(
    request,
    (identity, input) => releasePresenceSession(identity, input),
    204,
  );
}
