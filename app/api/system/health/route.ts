import { getDb } from "@/db";
import { organizations } from "@/db/schema";
import {
  engineDeadlineReconciliationHealth,
} from "@/src/adapters/d1/deadline-reconciliation-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().select({ id: organizations.id }).from(organizations).limit(1);
    const deadlineReconciliation =
      await engineDeadlineReconciliationHealth();

    return Response.json(
      {
        status: "ok",
        database: "ready",
        deadlineReconciliation,
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
