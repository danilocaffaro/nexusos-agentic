import type { RunnerCapabilityName } from "@/src/contracts/runners";
import { RUNNER_CAPABILITIES } from "./capability-protocol";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const capabilityNames = new Set<string>(RUNNER_CAPABILITIES);

export type AssignedRunRequest = {
  assignedRunnerId: string;
  requiredCapability?: RunnerCapabilityName;
};

export function parseAssignedRunRequest(
  input: Record<string, unknown>,
): AssignedRunRequest | undefined {
  const keys = Object.keys(input).sort();
  const hasRequiredCapability = keys.length === 2;
  if (
    !(
      (keys.length === 1 && keys[0] === "assignedRunnerId") ||
      (hasRequiredCapability &&
        keys[0] === "assignedRunnerId" &&
        keys[1] === "requiredCapability")
    ) ||
    typeof input.assignedRunnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(input.assignedRunnerId) ||
    (hasRequiredCapability &&
      (typeof input.requiredCapability !== "string" ||
        !capabilityNames.has(input.requiredCapability)))
  ) {
    return undefined;
  }

  return {
    assignedRunnerId: input.assignedRunnerId,
    ...(hasRequiredCapability
      ? {
          requiredCapability:
            input.requiredCapability as RunnerCapabilityName,
        }
      : {}),
  };
}
