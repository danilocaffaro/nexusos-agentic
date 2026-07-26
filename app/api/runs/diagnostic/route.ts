import {
  createDiagnosticRun,
  RunRepositoryError,
} from "@/src/adapters/d1/run-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return runnerWorkspaceRoute(
    request,
    (identity, input) => {
      if (Object.keys(input).length !== 0) {
        throw new RunRepositoryError("invalid_diagnostic_request", 400);
      }
      return createDiagnosticRun(identity);
    },
    201,
  );
}
