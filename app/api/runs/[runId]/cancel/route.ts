import {
  cancelDiagnosticRun,
  RunRepositoryError,
} from "@/src/adapters/d1/run-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return runnerWorkspaceRoute(request, (identity, input) => {
    if (Object.keys(input).length !== 0) {
      throw new RunRepositoryError("invalid_cancel_request", 400);
    }
    return cancelDiagnosticRun(identity, runId);
  });
}
