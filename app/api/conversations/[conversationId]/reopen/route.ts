import { reopenConversation } from "@/src/adapters/d1/collaboration-lifecycle-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return workspaceRoute(request, (identity, input) =>
    reopenConversation(identity, conversationId, input),
  );
}
