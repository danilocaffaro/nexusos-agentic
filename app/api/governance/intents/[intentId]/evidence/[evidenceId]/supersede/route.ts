import { supersedeIntentEvidence } from "@/src/adapters/d1/evidence-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ intentId: string; evidenceId: string }>;
  },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { intentId, evidenceId } = await context.params;
    return Response.json({
      evidence: await supersedeIntentEvidence(
        identity,
        intentId,
        evidenceId,
      ),
    }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown) {
  if (error instanceof IdentityRequiredError) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }
  if (error instanceof WorkspaceRepositoryError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  return Response.json(
    { error: "evidence_operation_failed" },
    { status: 500 },
  );
}
