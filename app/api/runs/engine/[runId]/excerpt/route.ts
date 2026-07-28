import {
  readEngineRunExcerpt,
} from "@/src/adapters/d1/engine-run-excerpt-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return runnerWorkspaceRoute(request, (identity) =>
    readEngineRunExcerpt(identity, runId),
  );
}
