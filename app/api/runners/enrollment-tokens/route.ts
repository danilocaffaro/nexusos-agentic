import { issueRunnerEnrollmentToken } from "@/src/adapters/d1/runner-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return runnerWorkspaceRoute(
    request,
    (identity, input) => issueRunnerEnrollmentToken(identity, input),
    201,
  );
}
