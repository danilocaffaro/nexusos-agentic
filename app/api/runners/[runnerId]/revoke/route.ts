import { revokeRunner } from "@/src/adapters/d1/runner-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
) {
  const { runnerId } = await context.params;
  return runnerWorkspaceRoute(request, (identity) =>
    revokeRunner(identity, runnerId),
  );
}
