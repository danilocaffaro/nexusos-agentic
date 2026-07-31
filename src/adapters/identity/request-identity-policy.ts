export type RequestIdentity = {
  id: string;
  kind: "human";
  displayName: string;
  organizationId: string;
};

export type RequestIdentityEnvironment = {
  NEXUS_ALLOW_LOCAL_IDENTITY?: string;
  NEXUS_ALLOW_TEST_IDENTITIES?: string;
  NEXUS_MESSAGE_INTEGRITY_KEY?: string;
  NEXUS_PRIVATE_ALPHA_IDENTITY?: string;
  NEXUS_PRIVATE_ALPHA_OWNER_EMAIL?: string;
  NEXUS_PUBLIC_ORIGIN?: string;
  NEXUS_REMOTE_ACCESS?: string;
  NEXUS_REMOTE_BOOTSTRAP_TOKEN_SHA256?: string;
  NEXUS_REMOTE_SESSION_TTL_SECONDS?: string;
};

export const SINGLE_USER_OWNER_ID = "principal-local-owner";
export const SINGLE_USER_ORGANIZATION_ID = "org-local-aurora";
const SITES_AUTHENTICATED_USER_EMAIL_HEADER =
  "oai-authenticated-user-email";
const MINIMUM_INTEGRITY_KEY_BYTES = 32;

const LOCAL_IDENTITY: RequestIdentity = {
  id: SINGLE_USER_OWNER_ID,
  kind: "human",
  displayName: "Local owner",
  organizationId: SINGLE_USER_ORGANIZATION_ID,
};

export class IdentityRequiredError extends Error {
  constructor() {
    super("A trusted NexusOS identity is required");
    this.name = "IdentityRequiredError";
  }
}

export class IdentityConfigurationError extends Error {
  constructor() {
    super("The NexusOS private alpha identity boundary is misconfigured");
    this.name = "IdentityConfigurationError";
  }
}

export function resolveRequestIdentity(
  request: Request,
  environment: RequestIdentityEnvironment,
): RequestIdentity {
  const isLocalHost = localHostname(request.url);

  if (environment.NEXUS_PRIVATE_ALPHA_IDENTITY === "1") {
    return resolvePrivateAlphaIdentity(request, environment, isLocalHost);
  }

  if (
    environment.NEXUS_ALLOW_TEST_IDENTITIES === "1" &&
    isLocalHost
  ) {
    const id = request.headers.get("x-nexus-test-principal");
    const organizationId = request.headers.get(
      "x-nexus-test-organization",
    );
    if (id && organizationId) {
      return {
        id,
        organizationId,
        kind: "human",
        displayName:
          request.headers.get("x-nexus-test-display-name") ??
          "Integration identity",
      };
    }
  }
  if (
    environment.NEXUS_ALLOW_LOCAL_IDENTITY === "1" &&
    isLocalHost
  ) {
    return LOCAL_IDENTITY;
  }

  throw new IdentityRequiredError();
}

function resolvePrivateAlphaIdentity(
  request: Request,
  environment: RequestIdentityEnvironment,
  isLocalHost: boolean,
): RequestIdentity {
  if (
    isLocalHost ||
    environment.NEXUS_ALLOW_LOCAL_IDENTITY === "1" ||
    environment.NEXUS_ALLOW_TEST_IDENTITIES === "1" ||
    !hasStrongMessageIntegrityKey(environment.NEXUS_MESSAGE_INTEGRITY_KEY)
  ) {
    throw new IdentityConfigurationError();
  }

  const expectedEmail = normalizeEmail(
    environment.NEXUS_PRIVATE_ALPHA_OWNER_EMAIL,
  );
  if (!expectedEmail) {
    throw new IdentityConfigurationError();
  }

  const forwardedEmail = normalizeEmail(
    request.headers.get(SITES_AUTHENTICATED_USER_EMAIL_HEADER) ?? undefined,
  );
  if (!forwardedEmail || forwardedEmail !== expectedEmail) {
    throw new IdentityRequiredError();
  }

  return {
    id: SINGLE_USER_OWNER_ID,
    kind: "human",
    displayName: forwardedEmail,
    organizationId: SINGLE_USER_ORGANIZATION_ID,
  };
}

export function hasStrongMessageIntegrityKey(
  value: string | undefined,
): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength >= MINIMUM_INTEGRITY_KEY_BYTES
  );
}

function localHostname(value: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new IdentityRequiredError();
  }
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function normalizeEmail(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.length > 254) {
    return null;
  }
  if (
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*$/iu.test(
      value,
    )
  ) {
    return null;
  }
  const parts = value.split("@");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    parts[0].length > 64 ||
    parts[0].startsWith(".") ||
    parts[0].endsWith(".") ||
    parts[0].includes("..") ||
    parts[1].startsWith(".") ||
    parts[1].endsWith(".") ||
    parts[1].includes("..")
  ) {
    return null;
  }
  return value.toLowerCase();
}
