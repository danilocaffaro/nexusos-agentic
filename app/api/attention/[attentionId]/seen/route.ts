import { markAttentionSeen } from "@/src/adapters/d1/attention-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ attentionId: string }> },
) {
  const { attentionId } = await context.params;
  return workspaceRoute(request, (identity, input) =>
    markAttentionSeen(identity, attentionId, input),
  );
}
