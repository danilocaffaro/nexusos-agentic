import { retractArtifactSupersession } from "@/src/adapters/d1/supersession-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ artifactId: string; relationId: string }>;
  },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { artifactId, relationId } = await context.params;
    const payload: unknown = await request.json().catch(() => undefined);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new WorkspaceRepositoryError("invalid_json_body", 400);
    }
    const result = await retractArtifactSupersession(
      identity,
      artifactId,
      relationId,
      payload as Record<string, unknown>,
    );
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof IdentityRequiredError) {
      return Response.json(
        { error: "authentication_required" },
        { status: 401 },
      );
    }
    if (error instanceof WorkspaceRepositoryError) {
      return Response.json(
        { error: error.code },
        { status: error.status },
      );
    }
    return Response.json(
      { error: "artifact_supersession_operation_failed" },
      { status: 500 },
    );
  }
}

