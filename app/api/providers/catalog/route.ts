import {
  requireWorkspaceMember,
  WorkspaceRepositoryError,
} from "@/src/adapters/d1/workspace-repository";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "@/src/adapters/identity/request-identity";
import {
  PROVIDER_CATALOG_VIEW_SPEC_VERSION,
  ProviderCatalogSourceError,
  type BundledProviderCatalogSource,
  type ProviderCatalogView,
} from "@/src/contracts/provider-catalog-source";
import { getBundledProviderCatalog } from "@/src/domain/providers/bundled-provider-catalog";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  vary: "Authorization, Cookie, X-Nexus-Test-Principal, X-Nexus-Test-Organization",
};

class ProviderCatalogRequestError extends Error {
  constructor() {
    super("invalid_provider_catalog_request");
    this.name = "ProviderCatalogRequestError";
  }
}

export function GET(request: Request): Promise<Response> {
  return providerCatalogRoute(request);
}

export async function providerCatalogRoute(
  request: Request,
  source: BundledProviderCatalogSource = getBundledProviderCatalog,
): Promise<Response> {
  try {
    const identity = requireRequestIdentity(request);
    await requireWorkspaceMember(identity);
    if (new URL(request.url).search || request.body !== null) {
      throw new ProviderCatalogRequestError();
    }
    const snapshot = await source();
    const view: ProviderCatalogView = {
      specVersion: PROVIDER_CATALOG_VIEW_SPEC_VERSION,
      sourceRef: {
        specVersion: snapshot.sourceRef.specVersion,
        source: snapshot.sourceRef.source,
        declarationSha256: snapshot.sourceRef.declarationSha256,
      },
      catalog: snapshot.projection,
    };
    return jsonResponse(view, 200);
  } catch (error) {
    if (error instanceof IdentityRequiredError) {
      return jsonResponse({ error: "authentication_required" }, 401);
    }
    if (
      error instanceof WorkspaceRepositoryError &&
      error.code === "workspace_membership_required"
    ) {
      return jsonResponse({ error: "workspace_membership_required" }, 403);
    }
    if (error instanceof ProviderCatalogRequestError) {
      return jsonResponse({ error: "invalid_provider_catalog_request" }, 400);
    }
    if (error instanceof ProviderCatalogSourceError) {
      return jsonResponse({ error: "provider_catalog_unavailable" }, 503);
    }
    return jsonResponse({ error: "provider_catalog_unavailable" }, 503);
  }
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
}

export function POST(): Response {
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
      allow: "GET",
    },
  });
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
