import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { RemoteAuthError } from "@/src/adapters/identity/remote-auth";
import {
  MessageFileRepositoryError,
} from "@/src/adapters/d1/message-file-repository";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

const ERROR_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export async function messageFileRoute(
  request: Request,
  handler: (
    identity: Awaited<ReturnType<typeof requireRequestIdentity>>,
  ) => Promise<Response>,
): Promise<Response> {
  try {
    return await handler(await requireRequestIdentity(request));
  } catch (error) {
    if (error instanceof RemoteAuthError) {
      return Response.json(
        { error: error.code },
        { status: error.status, headers: ERROR_HEADERS },
      );
    }
    if (error instanceof IdentityRequiredError) {
      return Response.json(
        { error: "authentication_required" },
        { status: 401, headers: ERROR_HEADERS },
      );
    }
    if (
      error instanceof MessageFileRepositoryError ||
      error instanceof WorkspaceRepositoryError
    ) {
      return Response.json(
        { error: error.code },
        { status: error.status, headers: ERROR_HEADERS },
      );
    }
    return Response.json(
      { error: "message_file_operation_failed" },
      { status: 500, headers: ERROR_HEADERS },
    );
  }
}
