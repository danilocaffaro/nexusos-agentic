import { listDiagnosticRuns } from "@/src/adapters/d1/run-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runnerWorkspaceRoute(request, (identity) =>
    listDiagnosticRuns(identity),
  );
}
