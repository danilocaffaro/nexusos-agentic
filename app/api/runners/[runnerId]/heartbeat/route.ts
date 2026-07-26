import { env } from "cloudflare:workers";
import {
  recordRunnerHeartbeat,
  requireActiveRunner,
  RunnerRepositoryError,
} from "@/src/adapters/d1/runner-repository";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  configuredRunnerAudience,
  isHeartbeatBody,
  verifyRunnerSignature,
} from "@/src/domain/runners/runner-protocol";

export const dynamic = "force-dynamic";

const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ runnerId: string }> },
) {
  try {
    const { runnerId } = await context.params;
    if (!/^rnr_[0-9a-f]{32}$/u.test(runnerId)) throw authenticationFailed();
    const url = new URL(request.url);
    if (url.search) throw authenticationFailed();
    const audience = configuredRunnerAudience(env.NEXUS_RUNNER_AUDIENCE);
    if (!audience) {
      return json(
        canonicalJson({ error: "runner_audience_unconfigured" }),
        503,
      );
    }
    if (request.headers.get("content-length") !== "2") {
      throw authenticationFailed();
    }
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!isHeartbeatBody(raw)) throw authenticationFailed();
    const active = await requireActiveRunner(runnerId);
    const signature = header(
      request,
      "x-nexus-signature",
      /^[A-Za-z0-9_-]{86}$/u,
    );
    const timestamp = header(
      request,
      "x-nexus-timestamp",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    const nonce = header(
      request,
      "x-nexus-nonce",
      /^[A-Za-z0-9_-]{22}$/u,
    );
    const nowMs = Date.now();
    const verified = await verifyRunnerSignature({
      signatureInput: {
        domain: "nexus-runner-heartbeat-v1",
        method: "POST",
        pathname: url.pathname,
        audience,
        body: raw,
      },
      publicKey: active.publicKey,
      signature,
      timestamp,
      nonce,
      nowMs,
    });
    if (!verified) throw authenticationFailed();
    const recorded = await recordRunnerHeartbeat({
      runnerId,
      organizationId: active.organizationId,
      nonce: verified.nonce,
      requestHash: verified.requestHash,
      now: new Date(nowMs).toISOString(),
    });
    return new Response(recorded.body, {
      status: 200,
      headers: {
        ...HEADERS,
        ...(recorded.replay ? { "x-nexus-replay": "1" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof RunnerRepositoryError) {
      return json(canonicalJson({ error: error.code }), error.status);
    }
    return json(canonicalJson({ error: "runner_heartbeat_failed" }), 500);
  }
}

function header(request: Request, name: string, pattern: RegExp): string {
  const value = request.headers.get(name) ?? "";
  if (!pattern.test(value)) throw authenticationFailed();
  return value;
}

function authenticationFailed(): RunnerRepositoryError {
  return new RunnerRepositoryError("runner_authentication_failed", 403);
}

function json(body: string, status: number): Response {
  return new Response(body, { status, headers: HEADERS });
}
