import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { RunnerRepositoryError } from "@/src/adapters/d1/runner-repository";
import { RunRepositoryError } from "@/src/adapters/d1/run-repository";
import { AdmissionPolicyRepositoryError } from "@/src/adapters/d1/admission-policy-repository";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const RUNNER_PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  vary:
    "Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization",
};

export async function runnerWorkspaceRoute<T>(
  request: Request,
  handler: (
    identity: ReturnType<typeof requireRequestIdentity>,
    input: Record<string, unknown>,
  ) => Promise<T>,
  successStatus = 200,
  invalidInputError?: () => Error,
) {
  try {
    const identity = requireRequestIdentity(request);
    const input =
      request.method === "GET"
        ? {}
        : await readJsonRecord(request, invalidInputError);
    const result = await handler(identity, input);
    return Response.json(result, {
      status: successStatus,
      headers: RUNNER_PRIVATE_HEADERS,
    });
  } catch (error) {
    return runnerRouteError(error);
  }
}

export function runnerRouteError(error: unknown): Response {
  if (error instanceof IdentityRequiredError) {
    return Response.json(
      { error: "authentication_required" },
      { status: 401, headers: RUNNER_PRIVATE_HEADERS },
    );
  }
  if (
    error instanceof RunnerRepositoryError ||
    error instanceof RunRepositoryError ||
    error instanceof AdmissionPolicyRepositoryError ||
    error instanceof WorkspaceRepositoryError
  ) {
    return Response.json(
      { error: error.code },
      { status: error.status, headers: RUNNER_PRIVATE_HEADERS },
    );
  }
  return Response.json(
    { error: "runner_operation_failed" },
    { status: 500, headers: RUNNER_PRIVATE_HEADERS },
  );
}

async function readJsonRecord(
  request: Request,
  invalidInputError?: () => Error,
): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => undefined);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    if (invalidInputError) throw invalidInputError();
    throw new RunnerRepositoryError("invalid_json_body", 400);
  }
  return value as Record<string, unknown>;
}
