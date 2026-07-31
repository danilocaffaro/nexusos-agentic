import { getD1 } from "@/db";
import {
  IdentityRequiredError,
  SINGLE_USER_ORGANIZATION_ID,
  SINGLE_USER_OWNER_ID,
  type RequestIdentity,
  type RequestIdentityEnvironment,
} from "@/src/adapters/identity/request-identity-policy";

const SESSION_COOKIE = "__Host-nexus_session";
const PASSWORD_ITERATIONS = 600_000;
const SESSION_BYTES = 32;
const SESSION_TTL_DEFAULT_SECONDS = 12 * 60 * 60;
const SESSION_TTL_MIN_SECONDS = 15 * 60;
const SESSION_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BLOCK_SECONDS = 15 * 60;

export type RemoteAuthStatus = {
  mode: "remote";
  activationRequired: boolean;
  authenticated: boolean;
  principal: RequestIdentity | null;
  expiresAt: string | null;
};

export type RemoteAuthEnvironment = RequestIdentityEnvironment;

export class RemoteAuthError extends IdentityRequiredError {
  constructor(
    readonly code:
      | "authentication_required"
      | "authentication_failed"
      | "activation_already_completed"
      | "activation_token_invalid"
      | "csrf_validation_failed"
      | "invalid_auth_request"
      | "remote_auth_misconfigured"
      | "too_many_login_attempts",
    readonly status: number,
  ) {
    super();
    this.message = code;
    this.name = "RemoteAuthError";
  }
}

export async function remoteAuthStatus(
  request: Request,
  environment: RemoteAuthEnvironment,
): Promise<RemoteAuthStatus> {
  requireRemoteConfiguration(environment);
  const credential = await readCredential();
  if (!credential) {
    return {
      mode: "remote",
      activationRequired: true,
      authenticated: false,
      principal: null,
      expiresAt: null,
    };
  }
  const session = await readLiveSession(request);
  return {
    mode: "remote",
    activationRequired: false,
    authenticated: Boolean(session),
    principal: session ? identityFromCredential(credential) : null,
    expiresAt: session?.expires_at ?? null,
  };
}

export async function activateRemoteAccess(
  request: Request,
  environment: RemoteAuthEnvironment,
  input: Record<string, unknown>,
): Promise<{ principal: RequestIdentity; headers: Headers }> {
  requireRemoteConfiguration(environment);
  requireSameOriginMutation(request, environment);
  if (await readCredential()) {
    throw new RemoteAuthError("activation_already_completed", 409);
  }

  const bootstrapToken = requiredSecret(input.bootstrapToken, 32, 256);
  const expectedTokenHash =
    environment.NEXUS_REMOTE_BOOTSTRAP_TOKEN_SHA256 ?? "";
  const providedTokenHash = await sha256Base64Url(
    new TextEncoder().encode(bootstrapToken),
  );
  if (!timingSafeEqual(providedTokenHash, expectedTokenHash)) {
    await appendAuthEvent("activation_rejected");
    throw new RemoteAuthError("activation_token_invalid", 401);
  }

  const login = requiredLogin(input.login);
  const displayName = requiredDisplayName(input.displayName);
  const passphrase = requiredPassphrase(input.passphrase);
  const salt = randomBase64Url(16);
  const passwordHash = await derivePassword(passphrase, salt);
  const now = new Date().toISOString();
  try {
    const d1 = getD1();
    await d1.batch([
      d1
        .prepare(
          `INSERT OR IGNORE INTO organizations (
             id, slug, name, status, created_at, updated_at
           ) VALUES (?, 'nexusos-local', 'NexusOS', 'active', ?, ?)`,
        )
        .bind(SINGLE_USER_ORGANIZATION_ID, now, now),
      d1
        .prepare(
          `INSERT OR IGNORE INTO principals (
             id, organization_id, kind, external_id, display_name,
             status, created_at, updated_at
           ) VALUES (?, ?, 'human', 'remote:owner', ?, 'active', ?, ?)`,
        )
        .bind(
          SINGLE_USER_OWNER_ID,
          SINGLE_USER_ORGANIZATION_ID,
          displayName,
          now,
          now,
        ),
      d1
        .prepare(
          `INSERT OR IGNORE INTO memberships (
             id, organization_id, principal_id, role, status,
             created_at, updated_at
           ) VALUES (
             'membership-local-owner', ?, ?, 'owner', 'active', ?, ?
           )`,
        )
        .bind(
          SINGLE_USER_ORGANIZATION_ID,
          SINGLE_USER_OWNER_ID,
          now,
          now,
        ),
      d1
        .prepare(
          `UPDATE principals
           SET display_name = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM projects WHERE organization_id = ?
             )`,
        )
        .bind(
          displayName,
          now,
          SINGLE_USER_OWNER_ID,
          SINGLE_USER_ORGANIZATION_ID,
          SINGLE_USER_ORGANIZATION_ID,
        ),
    ]);
    const ownerBoundary = await d1
      .prepare(
        `SELECT 1
         FROM organizations organization
         INNER JOIN principals principal
           ON principal.organization_id = organization.id
         INNER JOIN memberships membership
           ON membership.organization_id = organization.id
          AND membership.principal_id = principal.id
         WHERE organization.id = ?
           AND organization.status = 'active'
           AND principal.id = ?
           AND principal.kind = 'human'
           AND principal.status = 'active'
           AND membership.role = 'owner'
           AND membership.status = 'active'
         LIMIT 1`,
      )
      .bind(SINGLE_USER_ORGANIZATION_ID, SINGLE_USER_OWNER_ID)
      .first();
    if (!ownerBoundary) {
      throw new RemoteAuthError("remote_auth_misconfigured", 503);
    }
    await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO auth_credentials (
             principal_id, login, display_name, password_salt,
             password_hash, password_iterations, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          SINGLE_USER_OWNER_ID,
          login,
          displayName,
          salt,
          passwordHash,
          PASSWORD_ITERATIONS,
          now,
          now,
        ),
      getD1()
        .prepare(
          `INSERT INTO auth_events (
             id, principal_id, event_type, occurred_at
           ) VALUES (?, ?, 'activation_completed', ?)`,
        )
        .bind(crypto.randomUUID(), SINGLE_USER_OWNER_ID, now),
    ]);
  } catch {
    if (await readCredential()) {
      throw new RemoteAuthError("activation_already_completed", 409);
    }
    throw new RemoteAuthError("remote_auth_misconfigured", 503);
  }
  return createAuthenticatedSession(
    identityFromCredential({
      principal_id: SINGLE_USER_OWNER_ID,
      login,
      display_name: displayName,
      password_salt: salt,
      password_hash: passwordHash,
      password_iterations: PASSWORD_ITERATIONS,
    }),
    request,
    environment,
    "activation_session_created",
  );
}

export async function loginRemoteAccess(
  request: Request,
  environment: RemoteAuthEnvironment,
  input: Record<string, unknown>,
): Promise<{ principal: RequestIdentity; headers: Headers }> {
  requireRemoteConfiguration(environment);
  requireSameOriginMutation(request, environment);
  const login = requiredLogin(input.login);
  const passphrase = requiredPassphrase(input.passphrase);
  await requireLoginNotBlocked(login);

  const credential = await readCredential();
  const passwordValid =
    credential?.login === login &&
    credential.password_iterations === PASSWORD_ITERATIONS &&
    timingSafeEqual(
      await derivePassword(passphrase, credential.password_salt),
      credential.password_hash,
    );
  if (!credential || !passwordValid) {
    await recordLoginFailure(login);
    await appendAuthEvent("login_rejected");
    throw new RemoteAuthError("authentication_failed", 401);
  }

  await clearLoginFailures(login);
  return createAuthenticatedSession(
    identityFromCredential(credential),
    request,
    environment,
    "login_succeeded",
  );
}

export async function logoutRemoteAccess(
  request: Request,
  environment: RemoteAuthEnvironment,
): Promise<Headers> {
  requireRemoteConfiguration(environment);
  requireSameOriginMutation(request, environment);
  const token = readSessionToken(request);
  if (token) {
    const now = new Date().toISOString();
    await getD1()
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .bind(now, await sha256Base64Url(decodeBase64Url(token)))
      .run();
    await appendAuthEvent("logout_completed");
  }
  const headers = securityHeaders();
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  );
  return headers;
}

export async function requireRemoteSession(
  request: Request,
  environment: RemoteAuthEnvironment,
): Promise<RequestIdentity> {
  requireRemoteConfiguration(environment);
  requireSameOriginMutation(request, environment);
  const [credential, session] = await Promise.all([
    readCredential(),
    readLiveSession(request),
  ]);
  if (!credential || !session) {
    throw new RemoteAuthError("authentication_required", 401);
  }
  return identityFromCredential(credential);
}

export function remoteAuthErrorResponse(error: unknown): Response {
  if (error instanceof RemoteAuthError) {
    return Response.json(
      { error: error.code },
      { status: error.status, headers: securityHeaders() },
    );
  }
  return Response.json(
    { error: "remote_auth_operation_failed" },
    { status: 500, headers: securityHeaders() },
  );
}

export function securityHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function requireRemoteConfiguration(
  environment: RemoteAuthEnvironment,
): void {
  if (
    environment.NEXUS_REMOTE_ACCESS !== "1" ||
    !validPublicOrigin(environment.NEXUS_PUBLIC_ORIGIN) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(
      environment.NEXUS_REMOTE_BOOTSTRAP_TOKEN_SHA256 ?? "",
    )
  ) {
    throw new RemoteAuthError("remote_auth_misconfigured", 503);
  }
}

function requireSameOriginMutation(
  request: Request,
  environment: RemoteAuthEnvironment,
): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const publicOrigin = environment.NEXUS_PUBLIC_ORIGIN!;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    origin !== publicOrigin ||
    fetchSite === "cross-site" ||
    fetchSite === "same-site"
  ) {
    throw new RemoteAuthError("csrf_validation_failed", 403);
  }
}

function validPublicOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function createAuthenticatedSession(
  principal: RequestIdentity,
  request: Request,
  environment: RemoteAuthEnvironment,
  eventType: string,
): Promise<{ principal: RequestIdentity; headers: Headers }> {
  const token = randomBase64Url(SESSION_BYTES);
  const tokenHash = await sha256Base64Url(decodeBase64Url(token));
  const now = new Date();
  const ttlSeconds = sessionTtlSeconds(environment);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const userAgentHash = await sha256Base64Url(
    new TextEncoder().encode(
      (request.headers.get("user-agent") ?? "").slice(0, 512),
    ),
  );
  await getD1().batch([
    getD1()
      .prepare(
        `INSERT INTO auth_sessions (
           token_hash, principal_id, user_agent_hash, expires_at,
           created_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tokenHash,
        principal.id,
        userAgentHash,
        expiresAt,
        now.toISOString(),
        now.toISOString(),
      ),
    getD1()
      .prepare(
        `INSERT INTO auth_events (
           id, principal_id, event_type, occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), principal.id, eventType, now.toISOString()),
  ]);
  const headers = securityHeaders();
  headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSeconds}`,
  );
  return { principal, headers };
}

async function readLiveSession(
  request: Request,
): Promise<AuthSessionRow | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256Base64Url(decodeBase64Url(token));
  const now = new Date().toISOString();
  const session = await getD1()
    .prepare(
      `SELECT token_hash, principal_id, expires_at
       FROM auth_sessions
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND julianday(expires_at) > julianday(?)
       LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first<AuthSessionRow>();
  if (!session) return null;
  await getD1()
    .prepare(
      `UPDATE auth_sessions
       SET last_seen_at = ?
       WHERE token_hash = ? AND last_seen_at < ?`,
    )
    .bind(now, tokenHash, new Date(Date.now() - 5 * 60_000).toISOString())
    .run();
  return session;
}

function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const matches = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

async function readCredential(): Promise<AuthCredentialRow | null> {
  return getD1()
    .prepare(
      `SELECT
         principal_id, login, display_name, password_salt,
         password_hash, password_iterations
       FROM auth_credentials
       WHERE principal_id = ?
       LIMIT 1`,
    )
    .bind(SINGLE_USER_OWNER_ID)
    .first<AuthCredentialRow>();
}

function identityFromCredential(
  credential: AuthCredentialRow,
): RequestIdentity {
  return {
    id: credential.principal_id,
    kind: "human",
    displayName: credential.display_name,
    organizationId: SINGLE_USER_ORGANIZATION_ID,
  };
}

async function requireLoginNotBlocked(login: string): Promise<void> {
  const state = await getD1()
    .prepare(
      `SELECT blocked_until
       FROM auth_login_state
       WHERE login = ?`,
    )
    .bind(login)
    .first<{ blocked_until: string | null }>();
  if (
    state?.blocked_until &&
    Date.parse(state.blocked_until) > Date.now()
  ) {
    throw new RemoteAuthError("too_many_login_attempts", 429);
  }
}

async function recordLoginFailure(login: string): Promise<void> {
  const now = new Date();
  const current = await getD1()
    .prepare(
      `SELECT failure_count, window_started_at
       FROM auth_login_state
       WHERE login = ?`,
    )
    .bind(login)
    .first<{ failure_count: number; window_started_at: string }>();
  const windowActive =
    current &&
    Date.parse(current.window_started_at) > now.getTime() - LOGIN_BLOCK_SECONDS * 1000;
  const failureCount = windowActive ? current.failure_count + 1 : 1;
  const blockedUntil =
    failureCount >= LOGIN_FAILURE_LIMIT
      ? new Date(now.getTime() + LOGIN_BLOCK_SECONDS * 1000).toISOString()
      : null;
  await getD1()
    .prepare(
      `INSERT INTO auth_login_state (
         login, failure_count, window_started_at, blocked_until
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(login) DO UPDATE SET
         failure_count = excluded.failure_count,
         window_started_at = excluded.window_started_at,
         blocked_until = excluded.blocked_until`,
    )
    .bind(
      login,
      failureCount,
      windowActive ? current.window_started_at : now.toISOString(),
      blockedUntil,
    )
    .run();
}

async function clearLoginFailures(login: string): Promise<void> {
  await getD1()
    .prepare(`DELETE FROM auth_login_state WHERE login = ?`)
    .bind(login)
    .run();
}

async function appendAuthEvent(eventType: string): Promise<void> {
  await getD1()
    .prepare(
      `INSERT INTO auth_events (
         id, principal_id, event_type, occurred_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      SINGLE_USER_OWNER_ID,
      eventType,
      new Date().toISOString(),
    )
    .run();
}

function requiredLogin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !/^[a-z0-9][a-z0-9._@+-]{2,127}$/u.test(value)
  ) {
    throw new RemoteAuthError("invalid_auth_request", 400);
  }
  return value.toLowerCase();
}

function requiredDisplayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 2 ||
    value.length > 120
  ) {
    throw new RemoteAuthError("invalid_auth_request", 400);
  }
  return value;
}

function requiredPassphrase(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    new TextEncoder().encode(value).byteLength > 256
  ) {
    throw new RemoteAuthError("invalid_auth_request", 400);
  }
  return value;
}

function requiredSecret(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength
  ) {
    throw new RemoteAuthError("invalid_auth_request", 400);
  }
  return value;
}

async function derivePassword(
  passphrase: string,
  salt: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: exactArrayBuffer(decodeBase64Url(salt)),
      iterations: PASSWORD_ITERATIONS,
    },
    key,
    256,
  );
  return encodeBase64Url(new Uint8Array(bits));
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  return encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", exactArrayBuffer(value)),
    ),
  );
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |=
      (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    padded + "=".repeat((4 - (padded.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sessionTtlSeconds(
  environment: RemoteAuthEnvironment,
): number {
  const value = Number(environment.NEXUS_REMOTE_SESSION_TTL_SECONDS);
  return Number.isSafeInteger(value) &&
    value >= SESSION_TTL_MIN_SECONDS &&
    value <= SESSION_TTL_MAX_SECONDS
    ? value
    : SESSION_TTL_DEFAULT_SECONDS;
}

type AuthCredentialRow = {
  principal_id: string;
  login: string;
  display_name: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
};

type AuthSessionRow = {
  token_hash: string;
  principal_id: string;
  expires_at: string;
};
