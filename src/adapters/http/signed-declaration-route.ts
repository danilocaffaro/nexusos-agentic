import { env } from "cloudflare:workers";
import {
  DeclarationRepositoryError,
  type SignedDeclarationResult,
} from "@/src/adapters/d1/declaration-nonce";
import {
  requireActiveRunner,
  RunnerRepositoryError,
} from "@/src/adapters/d1/runner-repository";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import { runnerOperationRequestHash } from "@/src/domain/runners/lease-protocol";
import { CAPABILITY_REPORT_MAX_BYTES } from "@/src/domain/runners/capability-protocol";
import { ENGINE_REPORT_MAX_BYTES } from "@/src/domain/runners/engine-report-protocol";
import {
  configuredRunnerAudience,
  type RunnerSignatureDomain,
  verifyRunnerSignature,
} from "@/src/domain/runners/runner-protocol";

export const SIGNED_DECLARATION_MAX_BYTES = CAPABILITY_REPORT_MAX_BYTES;

if (SIGNED_DECLARATION_MAX_BYTES !== ENGINE_REPORT_MAX_BYTES) {
  throw new Error("Signed declaration transport bounds must remain equal");
}

const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;

export type SignedDeclarationContext = {
  runner: {
    id: string;
    organizationId: string;
    principalId: string;
    publicKey: string;
  };
  raw: Uint8Array;
  nonce: string;
  signedRequestHash: string;
  operationRequestHash: string;
  now: string;
};

export async function signedDeclarationRoute<T>(input: {
  request: Request;
  runnerId: string;
  domain: RunnerSignatureDomain;
  failureCode: string;
  parse: (raw: Uint8Array) => T | undefined;
  handle: (
    body: T,
    context: SignedDeclarationContext,
  ) => Promise<SignedDeclarationResult>;
}): Promise<Response> {
  try {
    if (!RUNNER_ID_PATTERN.test(input.runnerId)) throw runnerRejected();
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
      Number(declaredLength) > SIGNED_DECLARATION_MAX_BYTES
    ) {
      throw runnerRejected();
    }
    const raw = new Uint8Array(await input.request.arrayBuffer());
    if (raw.byteLength !== Number(declaredLength)) throw runnerRejected();
    const body = input.parse(raw);
    if (!body) throw runnerRejected();
    const keyId = header(
      input.request,
      "x-nexus-runner-id",
      RUNNER_ID_PATTERN,
    );
    if (keyId !== input.runnerId) throw runnerRejected();
    const active = await requireActiveRunner(input.runnerId);
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
        keyId,
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
      raw,
      nonce: verified.nonce,
      signedRequestHash: verified.requestHash,
      operationRequestHash: await runnerOperationRequestHash({
        domain: input.domain,
        runnerId: keyId,
        pathname: url.pathname,
        body: raw,
      }),
      now: new Date(nowMs).toISOString(),
    });
    return new Response(result.body, {
      status: result.status,
      headers: {
        ...HEADERS,
        ...(result.replay ? { "x-nexus-replay": "1" } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DeclarationRepositoryError) {
      return json(canonicalJson({ error: error.code }), error.status);
    }
    if (error instanceof RunnerRepositoryError) {
      return json(
        canonicalJson({ error: "runner_rejected" }),
        error.status === 503 ? 503 : 403,
      );
    }
    return json(canonicalJson({ error: input.failureCode }), 500);
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
