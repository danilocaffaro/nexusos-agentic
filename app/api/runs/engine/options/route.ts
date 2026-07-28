import {
  listEngineRunOptions,
} from "@/src/adapters/d1/engine-run-options-read-model";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runnerWorkspaceRoute(request, async (identity) => {
    if (new URL(request.url).searchParams.size > 0) {
      throw new WorkspaceRepositoryError(
        "unexpected_query_parameter",
        400,
      );
    }
    return listEngineRunOptions(identity);
  });
}
