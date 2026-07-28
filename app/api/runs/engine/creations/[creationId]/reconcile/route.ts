import { env } from "cloudflare:workers";
import {
  reconcileEngineRunCreation,
  RunRepositoryError,
} from "@/src/adapters/d1/run-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";
import {
  parseEngineRunCreationId,
} from "@/src/domain/runners/engine-run-creation-resolution";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ creationId: string }> },
) {
  const { creationId: rawCreationId } = await context.params;
  return runnerWorkspaceRoute(
    request,
    async (identity, input) => {
      const creationId = parseEngineRunCreationId(rawCreationId);
      if (
        !creationId ||
        Object.keys(input).length !== 0 ||
        new URL(request.url).searchParams.size !== 0
      ) {
        throw new RunRepositoryError(
          "invalid_engine_run_creation_reconciliation",
          400,
        );
      }
      const raceTestWinner = engineCreationRaceTestWinner(request);
      return reconcileEngineRunCreation(
        identity,
        creationId,
        raceTestWinner
          ? { participant: "reconcile", winner: raceTestWinner }
          : undefined,
      );
    },
    200,
    () =>
      new RunRepositoryError(
        "invalid_engine_run_creation_reconciliation",
        400,
      ),
  );
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
