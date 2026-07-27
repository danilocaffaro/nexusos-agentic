import type { RunnerCapabilityName } from "@/src/contracts/runners";

export const RUNNER_CAPABILITY_OPTIONS = [
  "node_permission_model",
  "bubblewrap",
  "landlock",
  "seccomp",
  "user_namespace",
  "docker",
  "podman",
] as const satisfies readonly RunnerCapabilityName[];

export function runnerCapabilityLabel(value: RunnerCapabilityName) {
  return {
    node_permission_model: "Node Permission Model",
    bubblewrap: "Bubblewrap",
    landlock: "Landlock",
    seccomp: "Seccomp",
    user_namespace: "User namespace",
    docker: "Docker",
    podman: "Podman",
  }[value];
}
