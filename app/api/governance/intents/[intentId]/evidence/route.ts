import {
  attachIntentEvidence,
  listIntentEvidence,
} from "@/src/adapters/d1/evidence-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ intentId: string }> },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { intentId } = await context.params;
    return Response.json(await listIntentEvidence(identity, intentId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ intentId: string }> },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { intentId } = await context.params;
    const payload: unknown = await request.json().catch(() => undefined);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new WorkspaceRepositoryError("invalid_json_body", 400);
    }
    const evidence = await attachIntentEvidence(
      identity,
      intentId,
      payload as Record<string, unknown>,
    );
    return Response.json({ evidence }, {
      status: 201,
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
