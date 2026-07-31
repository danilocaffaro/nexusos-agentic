import { env } from "cloudflare:workers";
import {
  remoteAuthErrorResponse,
  remoteAuthStatus,
  securityHeaders,
} from "@/src/adapters/identity/remote-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return Response.json(await remoteAuthStatus(request, env), {
      headers: securityHeaders(),
    });
  } catch (error) {
    return remoteAuthErrorResponse(error);
  }
}
