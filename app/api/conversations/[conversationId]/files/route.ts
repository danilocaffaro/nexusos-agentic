import { stageConversationFile } from "@/src/adapters/d1/message-file-repository";
import { messageFileRoute } from "@/src/adapters/http/message-file-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  return messageFileRoute(request, async (identity) =>
    Response.json(
      await stageConversationFile(identity, conversationId, request),
      {
        status: 201,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    ),
  );
}
