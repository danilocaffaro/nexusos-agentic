import {
  applyRunnerCapabilityReport,
  listRunnerCapabilityReports,
} from "@/src/adapters/d1/capability-report-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";
import { signedCapabilityReportRoute } from "@/src/adapters/http/signed-capability-report-route";
import { parseRunnerCapabilityReport } from "@/src/domain/runners/capability-protocol";

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
    listRunnerCapabilityReports(identity, runnerId, cursor),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
) {
  const { runnerId } = await context.params;
  return signedCapabilityReportRoute({
    request,
    runnerId,
    parse: parseRunnerCapabilityReport,
    handle: (report, signed) =>
      applyRunnerCapabilityReport({
        ...signed,
        report,
      }),
  });
}
