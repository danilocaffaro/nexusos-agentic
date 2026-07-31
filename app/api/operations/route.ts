import { env } from "cloudflare:workers";
import {
  assertPromptCipherKeysCoverLiveReferences,
  resolvePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import {
  createOperation,
  listOperations,
} from "@/src/adapters/d1/operation-repository";
import {
  listLiveProtectedPayloadKeyIds,
} from "@/src/adapters/d1/prompt-retention-repository";
import { requireRequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  RUNNER_PRIVATE_HEADERS,
  runnerRouteError,
  runnerWorkspaceRoute,
} from "@/src/adapters/http/runner-route";
import {
  OperationInputError,
  parseOperationIdempotencyKey,
  readOperationRequest,
} from "@/src/domain/operations";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runnerWorkspaceRoute(request, (identity) =>
    listOperations(identity),
  );
}

export async function POST(request: Request) {
  try {
    const identity = await requireRequestIdentity(request);
    const operationId = parseOperationIdempotencyKey(
      request.headers.get("idempotency-key"),
    );
    if (new URL(request.url).searchParams.size !== 0) {
      throw new OperationInputError("invalid_operation_request", 400);
    }
    const input = await readOperationRequest(request);
    const result = await createOperation(
      identity,
      operationId,
      input,
      async () => {
        const keyring = resolvePromptCipherKeyring({
          allowLocalIdentity: env.NEXUS_ALLOW_LOCAL_IDENTITY === "1",
          serialized: env.NEXUS_PROMPT_CIPHER_KEYS,
        });
        assertPromptCipherKeysCoverLiveReferences(
          keyring,
          await listLiveProtectedPayloadKeyIds(),
        );
        return new WebCryptoPromptCipher(keyring);
      },
    );
    return Response.json(result, {
      status: result.created ? 201 : 200,
      headers: RUNNER_PRIVATE_HEADERS,
    });
  } catch (error) {
    return runnerRouteError(error);
  }
}
