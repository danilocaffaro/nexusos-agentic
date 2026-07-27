import { waitUntil } from "cloudflare:workers";
import { reconcileDueEngineRunDeadlines } from "./deadline-reconciliation-repository";

const MUTATION_RECONCILE_COOLDOWN_MS = 30_000;
let mutationPassInFlight = false;
let lastMutationPassAt = 0;

export function scheduleMutationDeadlineReconciliation(): void {
  const now = Date.now();
  if (
    mutationPassInFlight ||
    now - lastMutationPassAt < MUTATION_RECONCILE_COOLDOWN_MS
  ) {
    return;
  }
  mutationPassInFlight = true;
  lastMutationPassAt = now;
  try {
    const pass = reconcileDueEngineRunDeadlines({ mode: "mutation" })
        .then((result) => {
          if (result.failures.length > 0 || result.truncated) {
            console.warn("[deadline-reconciler] mutation pass incomplete", {
              failures: result.failures.length,
              scanned: result.scanned,
              truncated: result.truncated,
            });
          }
        })
        .catch((error: unknown) => {
          console.warn("[deadline-reconciler] mutation pass failed", {
            cause: error instanceof Error ? error.name : "unknown_failure",
          });
        })
        .finally(() => {
          mutationPassInFlight = false;
        });
    waitUntil(pass);
  } catch (error) {
    mutationPassInFlight = false;
    lastMutationPassAt = 0;
    try {
      console.warn("[deadline-reconciler] mutation scheduling failed", {
        cause: error instanceof Error ? error.name : "unknown_failure",
      });
    } catch {
      // Maintenance scheduling must not alter the authoritative response.
    }
  }
}
