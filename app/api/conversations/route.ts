import {
  createConversation,
  listConversations,
} from "@/src/adapters/d1/collaboration-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return workspaceRoute(request, (identity) => listConversations(identity));
}

export async function POST(request: Request) {
  return workspaceRoute(
    request,
    (identity, input) => createConversation(identity, input),
    201,
  );
}
