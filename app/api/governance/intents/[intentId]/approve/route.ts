import {
  approveStoredIntent,
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
    const payload = (await request.json().catch(() => ({}))) as {
      parametersHash?: unknown;
    };
    const parametersHash =
      typeof payload.parametersHash === "string" ? payload.parametersHash : "";
    if (!/^[a-f0-9]{64}$/.test(parametersHash)) {
      return Response.json(
        { error: "a valid parametersHash is required" },
        { status: 400 },
      );
    }
    const intent = await approveStoredIntent(
      identity,
      intentId,
      parametersHash,
    );
    return Response.json({ intent });
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
