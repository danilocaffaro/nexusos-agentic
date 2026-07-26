import { env } from "cloudflare:workers";

export type RequestIdentity = {
  id: string;
  kind: "human";
  displayName: string;
  organizationId: string;
};

const LOCAL_IDENTITY: RequestIdentity = {
  id: "principal-local-owner",
  kind: "human",
  displayName: "Local owner",
  organizationId: "org-local-aurora",
};

export class IdentityRequiredError extends Error {
  constructor() {
    super("A trusted NexusOS identity is required");
    this.name = "IdentityRequiredError";
  }
}

export function requireRequestIdentity(request: Request): RequestIdentity {
  const { hostname } = new URL(request.url);
  if (
    env.NEXUS_ALLOW_LOCAL_IDENTITY === "1" &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]")
  ) {
    return LOCAL_IDENTITY;
  }

  throw new IdentityRequiredError();
}
