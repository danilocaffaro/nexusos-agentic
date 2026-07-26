import { completeDiagnosticRun } from "@/src/adapters/d1/run-repository";
import { signedRunRoute } from "@/src/adapters/http/signed-run-route";
import { parseRunCompleteBody } from "@/src/domain/runners/lease-protocol";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return signedRunRoute({
    request,
    runId,
    domain: "nexus-runner-run-complete-v1",
    parse: parseRunCompleteBody,
    handle: (body, signed) =>
      completeDiagnosticRun({
        ...signed,
        fence: body.fence,
        leaseId: body.leaseId,
        operationId: body.operationId,
        operationRequestHash: signed.operationRequestHash,
        outcomeStatus: body.outcome.status,
        outcomeSummary: body.outcome.summary,
      }),
  });
}
