import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import type {
  CliSessionObservationResolution,
} from "@/src/contracts/cli-session-observation";
import { resolveCliSessionObservation } from "@/src/domain/providers/cli-session-observation";
import { listEngineRunOptions } from "./engine-run-options-read-model";

export async function resolveCliSessionObservationFromD1(
  identity: RequestIdentity,
  request: unknown,
): Promise<CliSessionObservationResolution> {
  return resolveCliSessionObservation(
    request,
    () => listEngineRunOptions(identity),
  );
}
