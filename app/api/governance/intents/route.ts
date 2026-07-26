import {
  ensureLocalWorkspace,
  GovernanceRepositoryError,
  listGovernanceState,
  proposeSimulatedIntent,
} from "@/src/adapters/d1/governance-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const identity = requireRequestIdentity(request);
    await ensureLocalWorkspace();
    return Response.json(await listGovernanceState(identity.organizationId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const identity = requireRequestIdentity(request);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      return Response.json(
        { error: "a valid Idempotency-Key header is required" },
        { status: 400 },
      );
    }
    const payload = (await request.json().catch(() => ({}))) as {
      summary?: unknown;
    };
    const summary =
      typeof payload.summary === "string" ? payload.summary.trim() : "";
    if (!summary || summary.length > 160) {
      return Response.json(
        { error: "summary must contain 1 to 160 characters" },
        { status: 400 },
      );
    }
    const result = await proposeSimulatedIntent(
      identity,
      summary,
      idempotencyKey,
    );
    return Response.json(
      { intent: result.intent, created: result.created },
      { status: result.created ? 201 : 200 },
    );
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
  return Response.json({ error: "governance_operation_failed" }, { status: 500 });
}
