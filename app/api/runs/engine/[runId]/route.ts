import { getEngineRun } from "@/src/adapters/d1/run-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return runnerWorkspaceRoute(request, (identity) =>
    getEngineRun(identity, runId),
  );
}
