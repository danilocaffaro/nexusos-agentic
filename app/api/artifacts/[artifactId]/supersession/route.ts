import {
  declareArtifactSupersession,
  listArtifactSupersessions,
} from "@/src/adapters/d1/supersession-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  try {
    const identity = requireRequestIdentity(request);
    const { artifactId } = await context.params;
    return Response.json(
      await listArtifactSupersessions(identity, artifactId),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ artifactId: string }> },
) {
  try {
    const identity = requireRequestIdentity(request);
    const { artifactId } = await context.params;
    const payload: unknown = await request.json().catch(() => undefined);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new WorkspaceRepositoryError("invalid_json_body", 400);
    }
    const result = await declareArtifactSupersession(
      identity,
      artifactId,
      payload as Record<string, unknown>,
    );
    return Response.json(result, {
      status: result.created ? 201 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}

function routeError(error: unknown) {
  if (error instanceof IdentityRequiredError) {
    return Response.json(
      { error: "authentication_required" },
      { status: 401 },
    );
  }
  if (error instanceof WorkspaceRepositoryError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  return Response.json(
    { error: "artifact_supersession_operation_failed" },
    { status: 500 },
  );
}

