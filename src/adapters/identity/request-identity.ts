import { env } from "cloudflare:workers";

import {
  resolveRequestIdentity,
  type RequestIdentity,
} from "@/src/adapters/identity/request-identity-policy";

export {
  IdentityConfigurationError,
  IdentityRequiredError,
  type RequestIdentity,
} from "@/src/adapters/identity/request-identity-policy";

export function requireRequestIdentity(request: Request): RequestIdentity {
  return resolveRequestIdentity(request, env);
}
