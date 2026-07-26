import { renewDiagnosticLease } from "@/src/adapters/d1/run-repository";
import { signedRunRoute } from "@/src/adapters/http/signed-run-route";
import { parseLeaseRenewBody } from "@/src/domain/runners/lease-protocol";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return signedRunRoute({
    request,
    runId,
    domain: "nexus-runner-lease-renew-v1",
    parse: parseLeaseRenewBody,
    handle: (body, signed) =>
      renewDiagnosticLease({
        ...signed,
        fence: body.fence,
        leaseId: body.leaseId,
      }),
  });
}
