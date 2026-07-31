import { readMessageFile } from "@/src/adapters/d1/message-file-repository";
import { messageFileRoute } from "@/src/adapters/http/message-file-route";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  const { attachmentId } = await context.params;
  return messageFileRoute(request, (identity) =>
    readMessageFile(identity, attachmentId),
  );
}
