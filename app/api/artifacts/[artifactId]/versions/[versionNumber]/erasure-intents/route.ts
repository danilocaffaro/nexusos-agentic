import { getArtifactErasureImpact } from "@/src/adapters/d1/artifact-repository";
import {
  GovernanceRepositoryError,
  proposeArtifactErasureIntent,
} from "@/src/adapters/d1/governance-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ artifactId: string; versionNumber: string }>;
  },
) {
  try {
    const identity = requireRequestIdentity(request);
    const { artifactId, versionNumber } = await context.params;
    return Response.json(
      await getArtifactErasureImpact(
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
    const identity = requireRequestIdentity(request);
    const { artifactId, versionNumber } = await context.params;
    const payload: unknown = await request.json().catch(() => undefined);
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new GovernanceRepositoryError("invalid_json_body", 400);
    }
    const result = await proposeArtifactErasureIntent(
      identity,
      artifactId,
      parseVersion(versionNumber),
      (payload as Record<string, unknown>).reason,
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
  if (!Number.isSafeInteger(version) || version < 1) {
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
  if (error instanceof GovernanceRepositoryError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  return Response.json(
    { error: "artifact_erasure_operation_failed" },
    { status: 500 },
  );
}
