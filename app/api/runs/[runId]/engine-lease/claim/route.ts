import { claimEngineLease } from "@/src/adapters/d1/run-repository";
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
    handle: (body, signed) =>
      claimEngineLease({
        ...signed,
        engine: body.engine,
        operationId: body.operationId,
        operationRequestHash: signed.operationRequestHash,
      }),
  });
}
