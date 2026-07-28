import { waitUntil } from "cloudflare:workers";
import { getD1 } from "@/db";
import { reconcileDueEngineRunDeadlines } from "./deadline-reconciliation-repository";
import { reconcileDueEngineRunCreationRetention } from "./engine-run-creation-retention-repository";
import { reconcileDuePromptRetention } from "./prompt-retention-repository";

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
    const pass = runMutationMaintenance()
        .catch((error: unknown) => {
          console.warn("[engine-maintenance] mutation pass failed", {
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
      console.warn("[engine-maintenance] mutation scheduling failed", {
        cause: error instanceof Error ? error.name : "unknown_failure",
      });
    } catch {
      // Maintenance scheduling must not alter the authoritative response.
    }
  }
}

async function runMutationMaintenance(): Promise<void> {
  try {
    const deadline = await reconcileDueEngineRunDeadlines({
      mode: "mutation",
    });
    if (deadline.failures.length > 0 || deadline.truncated) {
      console.warn("[deadline-reconciler] mutation pass incomplete", {
        failures: deadline.failures.length,
        scanned: deadline.scanned,
        truncated: deadline.truncated,
      });
    }
  } catch (error) {
    console.warn("[deadline-reconciler] mutation pass failed", {
      cause: error instanceof Error ? error.name : "unknown_failure",
    });
  }

  try {
    const retention = await reconcileDuePromptRetention({
      mode: "mutation",
    });
    if (retention.failures.length > 0 || retention.truncated) {
      console.warn("[prompt-retention] mutation pass incomplete", {
        erased: retention.erased,
        failures: retention.failures.length,
        scanned: retention.scanned,
        truncated: retention.truncated,
      });
    }
  } catch (error) {
    console.warn("[prompt-retention] mutation pass failed", {
      cause: error instanceof Error ? error.name : "unknown_failure",
    });
  }

  try {
    const retention = await reconcileDueEngineRunCreationRetention(
      getD1(),
      { mode: "mutation" },
    );
    if (
      retention.deleted > 0 ||
      retention.skipped > 0 ||
      retention.truncated
    ) {
      console.info("[engine-creation-retention] mutation pass", {
        deleted: retention.deleted,
        scanned: retention.scanned,
        skipped: retention.skipped,
        truncated: retention.truncated,
      });
    }
  } catch (error) {
    console.warn("[engine-creation-retention] mutation pass failed", {
      cause: error instanceof Error ? error.name : "unknown_failure",
    });
  }
}
