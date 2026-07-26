import {
  executeStoredIntent,
  GovernanceRepositoryError,
} from "@/src/adapters/d1/governance-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { IntentTransitionError } from "@/src/domain/governance";

export async function POST(
  request: Request,
  context: { params: Promise<{ intentId: string }> },
) {
  try {
    const identity = requireRequestIdentity(request);
    const { intentId } = await context.params;
    const intent = await executeStoredIntent(identity, intentId);
    return Response.json({
      intent,
      receipt: {
        kind: "simulated",
        effect: "summary published in the deterministic Nexus simulator",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown) {
  if (error instanceof IdentityRequiredError) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }
  if (error instanceof GovernanceRepositoryError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof IntentTransitionError) {
    return Response.json({ error: error.code }, { status: 409 });
  }
  return Response.json({ error: "governance_operation_failed" }, { status: 500 });
}
