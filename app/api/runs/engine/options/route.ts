import {
  listEngineRunOptions,
} from "@/src/adapters/d1/engine-run-options-read-model";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runnerWorkspaceRoute(request, async (identity) => {
    return listEngineRunOptions(
      identity,
      new URL(request.url).searchParams.size > 0,
    );
  });
}
