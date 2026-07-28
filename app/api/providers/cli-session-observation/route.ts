import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "@/src/adapters/d1/workspace-repository";
import {
  resolveCliSessionObservationFromD1,
} from "@/src/adapters/d1/cli-session-observation-read-model";
import {
  ProviderCatalogSourceError,
  type BundledProviderCatalogSource,
} from "@/src/contracts/provider-catalog-source";
import type {
  CliSessionObservationResolution,
} from "@/src/contracts/cli-session-observation";
import {
  getBundledProviderCatalog,
} from "@/src/domain/providers/bundled-provider-catalog";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32_768;
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  vary:
    "Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization",
};

type RouteErrorCode =
  | "invalid_cli_session_observation_request"
  | "cli_session_observation_request_too_large"
  | "unsupported_media_type";

class CliSessionObservationRouteError extends Error {
  constructor(
    readonly code: RouteErrorCode,
    readonly status: 400 | 413 | 415,
  ) {
    super(code);
    this.name = "CliSessionObservationRouteError";
  }
}

export async function POST(request: Request): Promise<Response> {
  return cliSessionObservationRoute(request);
}

export async function cliSessionObservationRoute(
  request: Request,
  catalogSource: BundledProviderCatalogSource =
    getBundledProviderCatalog,
): Promise<Response> {
  try {
    const identity = requireRequestIdentity(request);
    await requireWorkspaceMember(identity);

    if (new URL(request.url).search) throw invalidRequest();
    requireJsonMediaType(request.headers.get("content-type"));
    const body = parseEnvelope(await readBoundedBody(request));
    const snapshot = await catalogSource();
    const resolution = await resolveCliSessionObservationFromD1(
      identity,
      {
        runnerId: body.runnerId,
        intent: body.intent,
        declaration: snapshot.declaration,
      },
    );
    return jsonResponse(
      publicResolution(resolution),
      200,
      {
        "x-nexus-provider-catalog-digest":
          snapshot.sourceRef.declarationSha256,
      },
    );
  } catch (error) {
    return routeError(error);
  }
}

function methodNotAllowed(): Response {
  return jsonResponse(
    { error: "method_not_allowed" },
    405,
    { allow: "POST" },
  );
}

export function GET(): Response {
  return methodNotAllowed();
}

export function PUT(): Response {
  return methodNotAllowed();
}

export function PATCH(): Response {
  return methodNotAllowed();
}

export function DELETE(): Response {
  return methodNotAllowed();
}

export function OPTIONS(): Response {
  return methodNotAllowed();
}

export function HEAD(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      ...PRIVATE_HEADERS,
      allow: "POST",
    },
  });
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  let declaredLength: number | undefined;
  try {
    declaredLength = parseDeclaredLength(
      request.headers.get("content-length"),
    );
  } catch (error) {
    if (
      error instanceof CliSessionObservationRouteError &&
      request.body
    ) {
      await request.body.cancel().catch(() => undefined);
    }
    throw error;
  }
  if (!request.body) {
    if (declaredLength !== undefined && declaredLength !== 0) {
      throw invalidRequest();
    }
    return new Uint8Array();
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    throw invalidRequest();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw invalidRequest();
      total += result.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      if (result.value.byteLength > 0) chunks.push(result.value.slice());
    }
  } catch (error) {
    if (error instanceof CliSessionObservationRouteError) throw error;
    throw invalidRequest();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The bounded body owns no reader after this point.
    }
  }

  if (declaredLength !== undefined && declaredLength !== total) {
    throw invalidRequest();
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

function parseDeclaredLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw invalidRequest();
  const maximum = String(MAX_BODY_BYTES);
  if (
    value.length > maximum.length ||
    (value.length === maximum.length && value > maximum)
  ) {
    throw tooLarge();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidRequest();
  return parsed;
}

function requireJsonMediaType(value: string | null): void {
  if (value === null) throw unsupportedMediaType();
  const parts = value.split(";").map((part) => part.trim());
  if (parts[0]?.toLowerCase() !== "application/json") {
    throw unsupportedMediaType();
  }
  if (
    parts.length > 2 ||
    (parts.length === 2 &&
      !/^charset\s*=\s*utf-8$/iu.test(parts[1] ?? ""))
  ) {
    throw unsupportedMediaType();
  }
}

function parseEnvelope(raw: Uint8Array): Readonly<{
  runnerId: unknown;
  intent: unknown;
}> {
  if (
    raw.byteLength < 1 ||
    raw.byteLength > MAX_BODY_BYTES ||
    hasUtf8Bom(raw)
  ) {
    throw invalidRequest();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(raw),
    );
  } catch {
    throw invalidRequest();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw invalidRequest();
  }
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "intent" ||
    keys[1] !== "runnerId"
  ) {
    throw invalidRequest();
  }
  const value = parsed as Record<string, unknown>;
  return {
    runnerId: value.runnerId,
    intent: value.intent,
  };
}

function publicResolution(
  resolution: CliSessionObservationResolution,
): CliSessionObservationResolution {
  if (resolution.status === "observed") {
    return {
      specVersion: resolution.specVersion,
      status: resolution.status,
      observationClaim: resolution.observationClaim,
      candidate: {
        providerId: resolution.candidate.providerId,
        modelId: resolution.candidate.modelId,
        cliEngine: resolution.candidate.cliEngine,
        bindingTrust: resolution.candidate.bindingTrust,
      },
      observation: {
        runnerId: resolution.observation.runnerId,
        reportId: resolution.observation.reportId,
        receivedAt: resolution.observation.receivedAt,
        freshUntil: resolution.observation.freshUntil,
        evaluatedAt: resolution.observation.evaluatedAt,
        engineVersion: resolution.observation.engineVersion,
        trust: resolution.observation.trust,
      },
    };
  }
  if (resolution.reason !== "connection_intent_rejected") {
    return {
      specVersion: resolution.specVersion,
      status: resolution.status,
      observationClaim: resolution.observationClaim,
      reason: resolution.reason,
    };
  }
  if (resolution.intentReason === "catalog_rejected") {
    return {
      specVersion: resolution.specVersion,
      status: resolution.status,
      observationClaim: resolution.observationClaim,
      reason: resolution.reason,
      intentReason: resolution.intentReason,
      catalogReason: resolution.catalogReason,
    };
  }
  return {
    specVersion: resolution.specVersion,
    status: resolution.status,
    observationClaim: resolution.observationClaim,
    reason: resolution.reason,
    intentReason: resolution.intentReason,
  };
}

function routeError(error: unknown): Response {
  if (error instanceof IdentityRequiredError) {
    return jsonResponse({ error: "authentication_required" }, 401);
  }
  if (
    error instanceof WorkspaceRepositoryError &&
    error.code === "workspace_membership_required"
  ) {
    return jsonResponse({ error: "workspace_membership_required" }, 403);
  }
  if (error instanceof CliSessionObservationRouteError) {
    return jsonResponse({ error: error.code }, error.status);
  }
  if (error instanceof ProviderCatalogSourceError) {
    return jsonResponse(
      { error: "provider_catalog_unavailable" },
      503,
    );
  }
  return jsonResponse({ error: "cli_session_observation_failed" }, 500);
}

function jsonResponse(
  body: Readonly<Record<string, unknown>>,
  status: number,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return Response.json(body, {
    status,
    headers: {
      ...PRIVATE_HEADERS,
      ...extraHeaders,
    },
  });
}

function hasUtf8Bom(raw: Uint8Array): boolean {
  return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

function invalidRequest(): CliSessionObservationRouteError {
  return new CliSessionObservationRouteError(
    "invalid_cli_session_observation_request",
    400,
  );
}

function tooLarge(): CliSessionObservationRouteError {
  return new CliSessionObservationRouteError(
    "cli_session_observation_request_too_large",
    413,
  );
}

function unsupportedMediaType(): CliSessionObservationRouteError {
  return new CliSessionObservationRouteError(
    "unsupported_media_type",
    415,
  );
}
