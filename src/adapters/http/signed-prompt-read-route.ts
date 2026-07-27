import { env } from "cloudflare:workers";
import {
  RunRepositoryError,
  type ActiveRunner,
  type EnginePromptReadResult,
} from "@/src/adapters/d1/run-repository";
import {
  requireActiveRunner,
  RunnerRepositoryError,
} from "@/src/adapters/d1/runner-repository";
import { PromptCipherError } from "@/src/adapters/crypto/web-crypto-prompt-cipher";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import { RUN_ID_PATTERN } from "@/src/domain/runners/lease-protocol";
import {
  configuredRunnerAudience,
  verifyRunnerSignature,
} from "@/src/domain/runners/runner-protocol";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export type SignedPromptReadContext = {
  runner: ActiveRunner;
  runId: string;
  nonce: string;
  signedRequestHash: string;
  now: string;
};

export async function signedEnginePromptReadRoute<T>(input: {
  request: Request;
  runId: string;
  parse: (raw: Uint8Array) => T | undefined;
  handle: (
    body: T,
    context: SignedPromptReadContext,
  ) => Promise<EnginePromptReadResult>;
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
        domain: "nexus-runner-engine-prompt-read-v1",
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
    const result = await input.handle(body, {
      runner: {
        id: active.id,
        organizationId: active.organizationId,
        principalId: active.principalId,
        publicKey: active.publicKey,
      },
      runId: input.runId,
      nonce: verified.nonce,
      signedRequestHash: verified.requestHash,
      now: new Date(nowMs).toISOString(),
    });
    return new Response(result.body.slice().buffer, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
        "x-nexus-prompt-bytes": String(result.promptBytes),
        "x-nexus-prompt-ref": result.promptRef,
        "x-nexus-prompt-sha256": result.promptSha256,
        ...(result.replay ? { "x-nexus-replay": "1" } : {}),
      },
    });
  } catch (error) {
    if (
      error instanceof RunRepositoryError ||
      error instanceof PromptCipherError
    ) {
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
  return new Response(body, { status, headers: JSON_HEADERS });
}
