import {
  applyRunnerEngineReport,
  listRunnerEngineReports,
} from "@/src/adapters/d1/engine-report-repository";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";
import { signedDeclarationRoute } from "@/src/adapters/http/signed-declaration-route";
import { parseRunnerEngineReport } from "@/src/domain/runners/engine-report-protocol";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
) {
  const url = new URL(request.url);
  const unexpected = [...url.searchParams.keys()].some(
    (key) => key !== "cursor",
  );
  if (unexpected || url.searchParams.getAll("cursor").length > 1) {
    return runnerWorkspaceRoute(request, async () => {
      throw new WorkspaceRepositoryError(
        unexpected ? "unexpected_query_parameter" : "invalid_cursor",
        400,
      );
    });
  }
  const { runnerId } = await context.params;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  return runnerWorkspaceRoute(request, (identity) =>
    listRunnerEngineReports(identity, runnerId, cursor),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
) {
  const { runnerId } = await context.params;
  return signedDeclarationRoute({
    request,
    runnerId,
    domain: "nexus-runner-engine-report-v1",
    failureCode: "engine_report_failed",
    parse: parseRunnerEngineReport,
    handle: (report, signed) =>
      applyRunnerEngineReport({
        ...signed,
        report,
      }),
  });
}
