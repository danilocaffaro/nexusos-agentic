import { getDb } from "@/db";
import { organizations } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().select({ id: organizations.id }).from(organizations).limit(1);

    return Response.json(
      {
        status: "ok",
        database: "ready",
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
