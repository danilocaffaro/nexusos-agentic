import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import {
  engineDeadlineReconciliationHealth,
} from "@/src/adapters/d1/deadline-reconciliation-repository";
import {
  promptRetentionHealth,
} from "@/src/adapters/d1/prompt-retention-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await getDb().select({ id: organizations.id }).from(organizations).limit(1);
    const testNow =
      env.NEXUS_ALLOW_TEST_IDENTITIES === "1"
        ? request.headers.get("x-nexus-test-now") ?? undefined
        : undefined;
    const [deadlineResult, retentionResult] = await Promise.allSettled([
      engineDeadlineReconciliationHealth(testNow),
      promptRetentionHealth(testNow),
    ]);
    const deadlineReconciliation =
      deadlineResult.status === "fulfilled"
        ? deadlineResult.value
        : { overdue: true };
    const promptRetention =
      retentionResult.status === "fulfilled"
        ? retentionResult.value
        : { overdue: true };

    return Response.json(
      {
        status: "ok",
        database: "ready",
        deadlineReconciliation,
        promptRetention,
        schemaVersion: 1,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    return Response.json(
      {
        status: "degraded",
        database: "unavailable",
        deadlineReconciliation: { overdue: true },
        promptRetention: { overdue: true },
        schemaVersion: 1,
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }
}
