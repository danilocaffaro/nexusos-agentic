import {
  DecisionPackageRepositoryError,
  getRenderedDecisionPackage,
} from "@/src/adapters/d1/decision-package-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
  type RequestIdentity,
} from "@/src/adapters/identity/request-identity";
import { decisionPackageAccessLog } from "@/src/adapters/observability/console-decision-package-access-log";
import { WorkspaceRepositoryError } from "@/src/adapters/d1/workspace-repository";

export const dynamic = "force-dynamic";

const VARY =
  "Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization";
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  vary: VARY,
};

export async function GET(
  request: Request,
  context: { params: Promise<{ intentId: string }> },
) {
  const requestId = crypto.randomUUID();
  let identity: RequestIdentity | undefined;
  let intentId: string | undefined;
  let format: "json" | "markdown" | undefined;
  try {
    identity = requireRequestIdentity(request);
    ({ intentId } = await context.params);
    const url = new URL(request.url);
    const requestedFormat = url.searchParams.get("format") ?? "json";
    if (requestedFormat !== "json" && requestedFormat !== "markdown") {
      throw new DecisionPackageRepositoryError(
        "invalid_decision_package_format",
        400,
      );
    }
    format = requestedFormat;
    const expected = url.searchParams.get("expectedRepresentationHash");
    if (
      (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) ||
      (expected !== null && format !== "markdown")
    ) {
      throw new DecisionPackageRepositoryError(
        "invalid_expected_representation_hash",
        400,
      );
    }
    const rendered = await getRenderedDecisionPackage(identity, intentId);
    if (
      expected !== null &&
      expected !== rendered.preview.representationHash
    ) {
      recordAccess({
        requestId,
        identity,
        intentId,
        format,
        outcome: "changed",
        status: 409,
        rendered,
        errorCode: "package_changed",
      });
      return Response.json(
        {
          error: "package_changed",
          representationHash: rendered.preview.representationHash,
          packageId: rendered.preview.packageId,
        },
        { status: 409, headers: PRIVATE_HEADERS },
      );
    }
    recordAccess({
      requestId,
      identity,
      intentId,
      format,
      outcome: "success",
      status: 200,
      rendered,
    });
    if (format === "json") {
      return Response.json(rendered.preview, {
        headers: {
          ...PRIVATE_HEADERS,
          "x-nexus-request-id": requestId,
        },
      });
    }
    const hash = rendered.preview.representationHash;
    return new Response(rendered.bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition":
          `attachment; filename="${filename(intentId, hash)}"`,
        "repr-digest": `sha-256=:${rendered.reprDigestBase64}:`,
        etag: `"sha256-${hash}"`,
        "x-nexus-request-id": requestId,
      },
    });
  } catch (error) {
    const response = routeError(error);
    recordAccess({
      requestId,
      identity,
      intentId,
      format,
      outcome:
        response.status === 401 || response.status === 403
          ? "denied"
          : "failed",
      status: response.status,
      errorCode: errorCode(error),
    });
    return response;
  }
}

type AccessInput = {
  requestId: string;
  identity?: RequestIdentity;
  intentId?: string;
  format?: "json" | "markdown";
  outcome: "success" | "denied" | "failed" | "changed";
  status: number;
  rendered?: Awaited<ReturnType<typeof getRenderedDecisionPackage>>;
  errorCode?: string;
};

function recordAccess(input: AccessInput): void {
  try {
    void Promise.resolve(
      decisionPackageAccessLog.record({
      requestId: input.requestId,
      ...(input.identity
        ? {
            organizationId: input.identity.organizationId,
            principalId: input.identity.id,
          }
        : {}),
      ...(input.intentId ? { intentId: input.intentId } : {}),
      ...(input.format ? { format: input.format } : {}),
      outcome: input.outcome,
      status: input.status,
      ...(input.rendered
        ? {
            representationHash:
              input.rendered.preview.representationHash,
            byteSize: input.rendered.preview.byteSize,
          }
        : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      }),
    ).catch(() => undefined);
  } catch {
    // Operational logging is best effort and cannot block the export.
  }
}

function routeError(error: unknown): Response {
  if (error instanceof IdentityRequiredError) {
    return Response.json(
      { error: "authentication_required" },
      { status: 401, headers: PRIVATE_HEADERS },
    );
  }
  if (
    error instanceof DecisionPackageRepositoryError ||
    error instanceof WorkspaceRepositoryError
  ) {
    return Response.json(
      { error: error.code },
      { status: error.status, headers: PRIVATE_HEADERS },
    );
  }
  return Response.json(
    { error: "decision_package_failed" },
    { status: 500, headers: PRIVATE_HEADERS },
  );
}

function errorCode(error: unknown): string {
  if (
    error instanceof DecisionPackageRepositoryError ||
    error instanceof WorkspaceRepositoryError
  ) {
    return error.code;
  }
  if (error instanceof IdentityRequiredError) {
    return "authentication_required";
  }
  return "decision_package_failed";
}

function filename(intentId: string, hash: string): string {
  const safeIntent = intentId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  return `decision-package-${safeIntent}-${hash.slice(0, 16)}.md`;
}
