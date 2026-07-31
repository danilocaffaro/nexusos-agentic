import { env } from "cloudflare:workers";
import {
  logoutRemoteAccess,
  remoteAuthErrorResponse,
} from "@/src/adapters/identity/remote-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return new Response(null, {
      status: 204,
      headers: await logoutRemoteAccess(request, env),
    });
  } catch (error) {
    return remoteAuthErrorResponse(error);
  }
}
