import { claimEngineLease } from "@/src/adapters/d1/run-repository";
import {
  scheduleMutationDeadlineReconciliation,
} from "@/src/adapters/d1/schedule-deadline-reconciliation";
import { signedRunRoute } from "@/src/adapters/http/signed-run-route";
import { parseEngineLeaseClaimBody } from "@/src/domain/runners/engine-control-plane";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  return signedRunRoute({
    request,
    runId,
    domain: "nexus-runner-engine-lease-claim-v1",
    parse: parseEngineLeaseClaimBody,
    handle: async (body, signed) => {
      const result = await claimEngineLease({
        ...signed,
        engine: body.engine,
        operationId: body.operationId,
        operationRequestHash: signed.operationRequestHash,
      });
      scheduleMutationDeadlineReconciliation();
      return result;
    },
  });
}
