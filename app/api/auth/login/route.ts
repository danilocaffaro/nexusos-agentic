import { env } from "cloudflare:workers";
import {
  loginRemoteAccess,
  RemoteAuthError,
  remoteAuthErrorResponse,
} from "@/src/adapters/identity/remote-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const contentType =
      request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const declaredLength = Number(request.headers.get("content-length"));
    if (
      contentType !== "application/json" ||
      (Number.isFinite(declaredLength) &&
        (declaredLength < 2 || declaredLength > 1_024))
    ) {
      return remoteAuthErrorResponse(
        new RemoteAuthError("invalid_auth_request", 400),
      );
    }
    const input: unknown = await request.json().catch(() => null);
    const authenticated = await loginRemoteAccess(
      request,
      env,
      input && !Array.isArray(input) && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {},
    );
    return Response.json(
      { authenticated: true, principal: authenticated.principal },
      { headers: authenticated.headers },
    );
  } catch (error) {
    return remoteAuthErrorResponse(error);
  }
}
