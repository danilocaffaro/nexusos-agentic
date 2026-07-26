import {
  removeConversationMember,
  updateConversationMember,
} from "@/src/adapters/d1/collaboration-lifecycle-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: {
    params: Promise<{ conversationId: string; principalId: string }>;
  },
) {
  const { conversationId, principalId } = await context.params;
  return workspaceRoute(request, (identity, input) =>
    updateConversationMember(identity, conversationId, principalId, input),
  );
}

export async function DELETE(
  request: Request,
  context: {
    params: Promise<{ conversationId: string; principalId: string }>;
  },
) {
  const { conversationId, principalId } = await context.params;
  return workspaceRoute(request, (identity, input) =>
    removeConversationMember(identity, conversationId, principalId, input),
  );
}
