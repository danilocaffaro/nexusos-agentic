import { removeConversationPin } from "@/src/adapters/d1/collaboration-lifecycle-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: {
    params: Promise<{ conversationId: string; pinId: string }>;
  },
) {
  const { conversationId, pinId } = await context.params;
  return workspaceRoute(request, (identity, input) =>
    removeConversationPin(identity, conversationId, pinId, input),
  );
}
