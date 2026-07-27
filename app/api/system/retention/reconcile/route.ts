import { env } from "cloudflare:workers";
import { reconcileDuePromptRetention } from "@/src/adapters/d1/prompt-retention-repository";
import { canonicalJson } from "@/src/domain/governance/canonical-json";

const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (env.NEXUS_ALLOW_LOCAL_IDENTITY !== "1") {
    return new Response(null, { status: 404 });
  }
  const url = new URL(request.url);
  if (
    url.search ||
    request.headers.get("x-nexus-local-operator") !==
      "retention-reconcile-v1" ||
    request.headers.get("content-type") !== "application/json" ||
    request.headers.get("content-length") !== "2" ||
    (await request.text()) !== "{}"
  ) {
    return json({ error: "local_operator_rejected" }, 403);
  }

  try {
    const testNow =
      env.NEXUS_ALLOW_TEST_IDENTITIES === "1"
        ? request.headers.get("x-nexus-test-now") ?? undefined
        : undefined;
    const result = await reconcileDuePromptRetention({
      mode: "scheduled",
      ...(testNow ? { now: testNow } : {}),
    });
    return json(result, result.failures.length === 0 ? 200 : 503);
  } catch {
    return json({ error: "prompt_retention_reconciliation_failed" }, 500);
  }
}

function json(value: unknown, status: number): Response {
  return new Response(canonicalJson(value), { status, headers: HEADERS });
}
