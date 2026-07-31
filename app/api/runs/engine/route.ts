import { env } from "cloudflare:workers";
import {
  assertPromptCipherKeysCoverLiveReferences,
  resolvePromptCipherKeyring,
  WebCryptoPromptCipher,
} from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import {
  listLiveProtectedPayloadKeyIds,
} from "@/src/adapters/d1/prompt-retention-repository";
import {
  createEngineRun,
  listEngineRuns,
  RunRepositoryError,
} from "@/src/adapters/d1/run-repository";
import {
  scheduleMutationDeadlineReconciliation,
} from "@/src/adapters/d1/schedule-deadline-reconciliation";
import {
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import {
  RUNNER_PRIVATE_HEADERS,
  runnerRouteError,
  runnerWorkspaceRoute,
} from "@/src/adapters/http/runner-route";
import {
  parseEngineRunCreateRequest,
  readBoundedEngineRunRequest,
} from "@/src/domain/runners/engine-control-plane";
import {
  parseEngineRunCreationId,
} from "@/src/domain/runners/engine-run-creation-resolution";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const cursorValues = searchParams.getAll("cursor");
  const limitValues = searchParams.getAll("limit");
  const valid =
    [...searchParams.keys()].every(
      (key) => key === "cursor" || key === "limit",
    ) &&
    cursorValues.length <= 1 &&
    limitValues.length <= 1;
  return runnerWorkspaceRoute(request, (identity) =>
    listEngineRuns(identity, {
      valid,
      ...(cursorValues[0] === undefined
        ? {}
        : { cursor: cursorValues[0] }),
      ...(limitValues[0] === undefined ? {} : { limit: limitValues[0] }),
    }),
  );
}

export async function POST(request: Request) {
  try {
    const identity = await requireRequestIdentity(request);
    const creationId = parseEngineRunCreationId(
      request.headers.get("idempotency-key"),
    );
    if (
      !creationId ||
      new URL(request.url).searchParams.size !== 0
    ) {
      throw new RunRepositoryError(
        "invalid_engine_run_creation_id",
        400,
      );
    }
    const raw = await readBoundedEngineRunRequest(request);
    const input = await parseEngineRunCreateRequest(raw);
    const raceTestWinner = engineCreationRaceTestWinner(request);
    const result = await createEngineRun(
      identity,
      creationId,
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
      raceTestWinner
        ? { participant: "create", winner: raceTestWinner }
        : undefined,
    );
    scheduleMutationDeadlineReconciliation();
    return Response.json(result.resolution, {
      status:
        result.resolution.state === "confirmed_not_created"
          ? 409
          : result.replay
            ? 200
            : 201,
      headers: RUNNER_PRIVATE_HEADERS,
    });
  } catch (error) {
    return runnerRouteError(error);
  }
}

function engineCreationRaceTestWinner(
  request: Request,
): "create" | "reconcile" | undefined {
  if (env.NEXUS_ALLOW_TEST_IDENTITIES !== "1") return undefined;
  const value = request.headers.get(
    "x-nexus-test-engine-creation-race-winner",
  );
  return value === "create" || value === "reconcile"
    ? value
    : undefined;
}
