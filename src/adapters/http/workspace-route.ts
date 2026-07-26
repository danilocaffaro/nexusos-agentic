import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export async function workspaceRoute<T>(
  request: Request,
  handler: (
    identity: ReturnType<typeof requireRequestIdentity>,
    input: Record<string, unknown>,
  ) => Promise<T>,
  successStatus = 200,
) {
  try {
    const identity = requireRequestIdentity(request);
    const input =
      request.method === "GET" ? {} : await readJsonRecord(request);
    const result = await handler(identity, input);
    const headers = { "cache-control": "no-store" };
    return successStatus === 204
      ? new Response(null, { status: 204, headers })
      : Response.json(result, { status: successStatus, headers });
  } catch (error) {
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
      { error: "workspace_operation_failed" },
      { status: 500 },
    );
  }
}

async function readJsonRecord(
  request: Request,
): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => undefined);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new WorkspaceRepositoryError("invalid_json_body", 400);
  }
  return value as Record<string, unknown>;
}
