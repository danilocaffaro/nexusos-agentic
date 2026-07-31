import {
  listArtifactReviews,
  recordArtifactReview,
} from "@/src/adapters/d1/review-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ artifactId: string; versionNumber: string }>;
  },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { artifactId, versionNumber } = await context.params;
    return Response.json(
      await listArtifactReviews(
        identity,
        artifactId,
        parseVersion(versionNumber),
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ artifactId: string; versionNumber: string }>;
  },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { artifactId, versionNumber } = await context.params;
    const payload: unknown = await request.json().catch(() => undefined);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new WorkspaceRepositoryError("invalid_json_body", 400);
    }
    const result = await recordArtifactReview(
      identity,
      artifactId,
      parseVersion(versionNumber),
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

function parseVersion(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new WorkspaceRepositoryError("invalid_artifact_version", 400);
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) {
    throw new WorkspaceRepositoryError("invalid_artifact_version", 400);
  }
  return version;
}

function routeError(error: unknown) {
  if (error instanceof IdentityRequiredError) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }
  if (error instanceof WorkspaceRepositoryError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  return Response.json(
    { error: "artifact_review_operation_failed" },
    { status: 500 },
  );
}
