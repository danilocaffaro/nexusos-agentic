import {
  createAssignedDiagnosticRun,
  RunRepositoryError,
} from "@/src/adapters/d1/run-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return runnerWorkspaceRoute(
    request,
    (identity, input) => createAssignedDiagnosticRun(identity, input),
    201,
    () =>
      new RunRepositoryError("invalid_assigned_run_request", 400),
  );
}
