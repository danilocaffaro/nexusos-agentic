import { revokeRunnerEnrollmentToken } from "@/src/adapters/d1/runner-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId } = await context.params;
  return runnerWorkspaceRoute(request, (identity) =>
    revokeRunnerEnrollmentToken(identity, tokenId),
  );
}
