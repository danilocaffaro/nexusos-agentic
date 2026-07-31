import { env } from "cloudflare:workers";
import {
  activateRemoteAccess,
  remoteAuthErrorResponse,
} from "@/src/adapters/identity/remote-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await readAuthInput(request);
    const activated = await activateRemoteAccess(request, env, input);
    return Response.json(
      { authenticated: true, principal: activated.principal },
      { status: 201, headers: activated.headers },
    );
  } catch (error) {
    return remoteAuthErrorResponse(error);
  }
}

async function readAuthInput(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    return {};
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    (declaredLength < 2 || declaredLength > 2_048)
  ) {
    return {};
  }
  const value: unknown = await request.json().catch(() => null);
  return value && !Array.isArray(value) && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
