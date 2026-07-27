import { renewRunLease } from "@/src/adapters/d1/run-repository";
import {
  scheduleMutationDeadlineReconciliation,
} from "@/src/adapters/d1/schedule-deadline-reconciliation";
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
    handle: async (body, signed) => {
      const result = await renewRunLease({
        ...signed,
        fence: body.fence,
        leaseId: body.leaseId,
      });
      scheduleMutationDeadlineReconciliation();
      return result;
    },
  });
}
