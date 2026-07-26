import { env } from "cloudflare:workers";
import {
  RunRepositoryError,
  type ActiveRunner,
  type SignedRunResult,
} from "@/src/adapters/d1/run-repository";
import {
  requireActiveRunner,
  RunnerRepositoryError,
} from "@/src/adapters/d1/runner-repository";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  RUN_ID_PATTERN,
  runnerOperationRequestHash,
} from "@/src/domain/runners/lease-protocol";
import {
  configuredRunnerAudience,
  type RunnerSignatureDomain,
  verifyRunnerSignature,
} from "@/src/domain/runners/runner-protocol";

const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export type SignedRunRouteContext = {
  runner: ActiveRunner;
  runId: string;
  raw: Uint8Array;
  nonce: string;
  signedRequestHash: string;
  operationRequestHash: string;
  now: string;
};

export async function signedRunRoute<T>(input: {
  request: Request;
  runId: string;
  domain: RunnerSignatureDomain;
  parse: (raw: Uint8Array) => T | undefined;
  handle: (body: T, context: SignedRunRouteContext) => Promise<SignedRunResult>;
}): Promise<Response> {
  try {
    if (!RUN_ID_PATTERN.test(input.runId)) throw runnerRejected();
    const url = new URL(input.request.url);
    if (url.search) throw runnerRejected();
    const audience = configuredRunnerAudience(env.NEXUS_RUNNER_AUDIENCE);
    if (!audience) {
      return json(
        canonicalJson({ error: "runner_audience_unconfigured" }),
        503,
      );
    }
    const declaredLength = input.request.headers.get("content-length");
    if (
      !declaredLength ||
      !/^[1-9]\d{0,3}$/u.test(declaredLength) ||
      Number(declaredLength) > 4_096
    ) {
      throw runnerRejected();
    }
    const raw = new Uint8Array(await input.request.arrayBuffer());
    if (raw.byteLength !== Number(declaredLength)) throw runnerRejected();
    const body = input.parse(raw);
    if (!body) throw runnerRejected();
    const runnerId = header(
      input.request,
      "x-nexus-runner-id",
      /^rnr_[0-9a-f]{32}$/u,
    );
    const active = await requireActiveRunner(runnerId);
    const signature = header(
      input.request,
      "x-nexus-signature",
      /^[A-Za-z0-9_-]{86}$/u,
    );
    const timestamp = header(
      input.request,
      "x-nexus-timestamp",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    const nonce = header(
      input.request,
      "x-nexus-nonce",
      /^[A-Za-z0-9_-]{22}$/u,
    );
    const nowMs = Date.now();
    const verified = await verifyRunnerSignature({
      signatureInput: {
        domain: input.domain,
        keyId: runnerId,
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
    if (!verified) throw runnerRejected();
    const context: SignedRunRouteContext = {
      runner: {
        id: active.id,
        organizationId: active.organizationId,
        principalId: active.principalId,
        publicKey: active.publicKey,
      },
      runId: input.runId,
      raw,
      nonce: verified.nonce,
      signedRequestHash: verified.requestHash,
      operationRequestHash: await runnerOperationRequestHash({
        domain: input.domain,
        runnerId,
        pathname: url.pathname,
        body: raw,
      }),
      now: new Date(nowMs).toISOString(),
    };
    const result = await input.handle(body, context);
    return new Response(result.body, {
      status: result.status,
      headers: {
        ...HEADERS,
        ...(result.replay ? { "x-nexus-replay": "1" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof RunRepositoryError) {
      return json(canonicalJson({ error: error.code }), error.status);
    }
    if (error instanceof RunnerRepositoryError) {
      return json(
        canonicalJson({ error: "runner_rejected" }),
        error.status === 503 ? 503 : 403,
      );
    }
    return json(canonicalJson({ error: "run_operation_failed" }), 500);
  }
}

function header(request: Request, name: string, pattern: RegExp): string {
  const value = request.headers.get(name) ?? "";
  if (!pattern.test(value)) throw runnerRejected();
  return value;
}

function runnerRejected(): RunnerRepositoryError {
  return new RunnerRepositoryError("runner_rejected", 403);
}

function json(body: string, status: number): Response {
  return new Response(body, { status, headers: HEADERS });
}
