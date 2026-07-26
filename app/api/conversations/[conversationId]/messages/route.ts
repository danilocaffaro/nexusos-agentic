import {
  listMessages,
  parseAfterSequence,
  sendMessage,
} from "@/src/adapters/d1/collaboration-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return workspaceRoute(request, (identity) =>
    listMessages(identity, conversationId, parseAfterSequence(request)),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return workspaceRoute(
    request,
    (identity, input) => sendMessage(identity, conversationId, input),
    201,
  );
}
