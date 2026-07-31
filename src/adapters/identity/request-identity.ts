import { env } from "cloudflare:workers";

import {
  resolveRequestIdentity,
  type RequestIdentity,
} from "@/src/adapters/identity/request-identity-policy";
import { requireRemoteSession } from "@/src/adapters/identity/remote-auth";

export {
  IdentityConfigurationError,
  IdentityRequiredError,
  type RequestIdentity,
} from "@/src/adapters/identity/request-identity-policy";

export async function requireRequestIdentity(
  request: Request,
): Promise<RequestIdentity> {
  if (env.NEXUS_REMOTE_ACCESS === "1") {
    return requireRemoteSession(request, env);
  }
  return resolveRequestIdentity(request, env);
}
