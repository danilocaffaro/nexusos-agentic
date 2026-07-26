import type { RunnerLiveness } from "../../contracts/runners";

export function deriveRunnerLiveness(input: {
  status: "active" | "revoked";
  lastSeenAt?: string;
  nowMs: number;
}): RunnerLiveness {
  if (input.status === "revoked") return "revoked";
  if (!input.lastSeenAt) return "pending";
  const ageMs = Math.max(0, input.nowMs - Date.parse(input.lastSeenAt));
  if (ageMs < 90_000) return "online";
  if (ageMs < 600_000) return "stale";
  return "offline";
}
