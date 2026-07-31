import {
  publishOperation,
} from "@/src/adapters/d1/operation-repository";
import { requireRequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  RUNNER_PRIVATE_HEADERS,
  runnerRouteError,
} from "@/src/adapters/http/runner-route";
import {
  OPERATION_ID_PATTERN,
  OperationInputError,
  readOperationPublishRequest,
} from "@/src/domain/operations";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
) {
  try {
    const identity = await requireRequestIdentity(request);
    const { operationId } = await context.params;
    if (
      !OPERATION_ID_PATTERN.test(operationId) ||
      new URL(request.url).searchParams.size !== 0
    ) {
      throw new OperationInputError("invalid_operation_request", 400);
    }
    await readOperationPublishRequest(request);
    const result = await publishOperation(identity, operationId);
    return Response.json(result, {
      status: result.published ? 201 : 200,
      headers: RUNNER_PRIVATE_HEADERS,
    });
  } catch (error) {
    return runnerRouteError(error);
  }
}
