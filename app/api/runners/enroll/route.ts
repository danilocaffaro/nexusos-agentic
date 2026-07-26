import { env } from "cloudflare:workers";
import {
  enrollRunner,
  RunnerRepositoryError,
} from "@/src/adapters/d1/runner-repository";
import { canonicalJson } from "@/src/domain/governance/canonical-json";
import {
  configuredRunnerAudience,
  hashRunnerToken,
  verifyRunnerSignature,
} from "@/src/domain/runners/runner-protocol";

export const dynamic = "force-dynamic";

const MAX_ENROLLMENT_BODY_BYTES = 4096;
const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};
const REJECTION_BODY = canonicalJson({ error: "enrollment_rejected" });

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.search) throw enrollmentRejected();
    const audience = configuredRunnerAudience(env.NEXUS_RUNNER_AUDIENCE);
    if (!audience) {
      return jsonBytes(
        canonicalJson({ error: "runner_audience_unconfigured" }),
        503,
      );
    }
    const declaredLength = request.headers.get("content-length");
    if (
      !/^\d{1,4}$/u.test(declaredLength ?? "") ||
      Number(declaredLength) > MAX_ENROLLMENT_BODY_BYTES
    ) {
      throw enrollmentRejected();
    }
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength < 2 || raw.byteLength > MAX_ENROLLMENT_BODY_BYTES) {
      throw enrollmentRejected();
    }
    const displayName = parseDisplayName(raw);
    const token = parseBearerToken(request.headers.get("authorization"));
    const publicKey = requiredHeader(
      request,
      "x-nexus-runner-key",
      /^[A-Za-z0-9_-]{43}$/u,
    );
    const signature = requiredHeader(
      request,
      "x-nexus-signature",
      /^[A-Za-z0-9_-]{86}$/u,
    );
    const timestamp = requiredHeader(
      request,
      "x-nexus-timestamp",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    const nonce = requiredHeader(
      request,
      "x-nexus-nonce",
      /^[A-Za-z0-9_-]{22}$/u,
    );
    const nowMs = Date.now();
    const [tokenHash, verified] = await Promise.all([
      hashRunnerToken(token),
      verifyRunnerSignature({
        signatureInput: {
          domain: "nexus-runner-enroll-v1",
          method: "POST",
          pathname: url.pathname,
          audience,
          body: raw,
        },
        publicKey,
        signature,
        timestamp,
        nonce,
        nowMs,
      }),
    ]);
    if (!tokenHash || !verified) throw enrollmentRejected();
    const result = await enrollRunner({
      tokenHash,
      publicKey,
      displayName,
      now: new Date(nowMs).toISOString(),
    });
    return jsonBytes(canonicalJson(result), 200);
  } catch (error) {
    if (
      error instanceof RunnerRepositoryError &&
      error.code === "conflict_retry"
    ) {
      return jsonBytes(canonicalJson({ error: error.code }), error.status);
    }
    if (error instanceof RunnerRepositoryError) {
      return jsonBytes(REJECTION_BODY, 403);
    }
    return jsonBytes(canonicalJson({ error: "runner_enrollment_failed" }), 500);
  }
}

function parseBearerToken(value: string | null): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(value ?? "");
  if (!match) throw enrollmentRejected();
  return match[1];
}

function requiredHeader(
  request: Request,
  name: string,
  pattern: RegExp,
): string {
  const value = request.headers.get(name) ?? "";
  if (!pattern.test(value)) throw enrollmentRejected();
  return value;
}

function parseDisplayName(raw: Uint8Array): string {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      Object.keys(value).length !== 1 ||
      !("displayName" in value) ||
      typeof value.displayName !== "string" ||
      value.displayName !== value.displayName.trim() ||
      value.displayName.length < 1 ||
      value.displayName.length > 120
    ) {
      throw enrollmentRejected();
    }
    return value.displayName;
  } catch (error) {
    if (error instanceof RunnerRepositoryError) throw error;
    throw enrollmentRejected();
  }
}

function enrollmentRejected(): RunnerRepositoryError {
  return new RunnerRepositoryError("enrollment_rejected", 403);
}

function jsonBytes(body: string, status: number): Response {
  return new Response(body, { status, headers: HEADERS });
}
