import { claimDiagnosticLease } from "@/src/adapters/d1/run-repository";
import { signedRunRoute } from "@/src/adapters/http/signed-run-route";
import { parseLeaseClaimBody } from "@/src/domain/runners/lease-protocol";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return signedRunRoute({
    request,
    runId,
    domain: "nexus-runner-lease-claim-v1",
    parse: parseLeaseClaimBody,
    handle: (body, signed) =>
      claimDiagnosticLease({
        ...signed,
        operationId: body.operationId,
        operationRequestHash: signed.operationRequestHash,
      }),
  });
}
