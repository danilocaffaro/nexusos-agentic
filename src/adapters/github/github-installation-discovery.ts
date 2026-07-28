import {
  GITHUB_REPOSITORY_PERMISSION_NAMES,
  GITHUB_REPOSITORY_SELECTIONS,
} from "../../contracts/github-authorization";
import {
  GITHUB_INSTALLATION_DISCOVERY_API_ORIGIN,
  GITHUB_INSTALLATION_DISCOVERY_API_VERSION,
  GITHUB_INSTALLATION_DISCOVERY_LEASE_SKEW_MS,
  GITHUB_INSTALLATION_DISCOVERY_MAX_HTTP_CALLS,
  GITHUB_INSTALLATION_DISCOVERY_MAX_REPOSITORY_PAGES,
  GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES,
  GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE,
  GITHUB_INSTALLATION_DISCOVERY_REQUEST_TIMEOUT_MS,
  GITHUB_INSTALLATION_DISCOVERY_TOTAL_TIMEOUT_MS,
  GITHUB_INSTALLATION_DISCOVERY_USER_AGENT,
  GitHubInstallationDiscoveryError,
} from "../../contracts/github-installation-discovery";
import type {
  GitHubInstallationDiscoveryCredentialLease,
  GitHubInstallationDiscoveryHttpObservation,
  GitHubInstallationDiscoveryInput,
  GitHubInstallationDiscoveryRateLimit,
  GitHubInstallationDiscoveryTransport,
} from "../../contracts/github-installation-discovery";
import {
  GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES,
} from "../../contracts/github-installation-source";
import {
  GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION,
} from "../../contracts/github-installation-snapshot";
import {
  parseGitHubRepositoryInstallation,
} from "../../domain/github/github-delivery";

const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const MAX_GITHUB_ID = "9223372036854775807";
const TOKEN = /^[\x21-\x7e]{1,8192}$/u;
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)$/u;
const CONTENT_TYPE = /^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/iu;
const CURSOR_PREFIX = "github-rest-page:";

type Runtime = Readonly<{
  request(request: Request): Promise<Response>;
  now(): number;
  timeoutSignal(timeoutMs: number): AbortSignal;
  observe(observation: GitHubInstallationDiscoveryHttpObservation): void;
}>;

export type GitHubInstallationDiscoveryRuntime = Readonly<{
  request?: (request: Request) => Promise<Response>;
  now?: () => number;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
  observe?: (observation: GitHubInstallationDiscoveryHttpObservation) => void;
}>;

type CapturedLease = {
  readonly kind: GitHubInstallationDiscoveryCredentialLease["kind"];
  readonly installationId: string;
  readonly expiresAtEpochMs: number;
  readonly reveal: GitHubInstallationDiscoveryCredentialLease["reveal"];
  readonly release: GitHubInstallationDiscoveryCredentialLease["release"];
  secret: string | undefined;
  released: boolean;
};

type InstallationMetadata = Readonly<{
  installationId: string;
  repositorySelection: "all" | "selected";
  permissions: Readonly<Record<string, "read" | "write">>;
  updatedAt: string;
  etag: string | null;
}>;

type RepositoryFixture = Readonly<{
  repositoryId: string;
  owner: string;
  name: string;
}>;

type JsonResponse = Readonly<{
  value: unknown;
  etag: string | null;
}>;

export function createGitHubInstallationDiscoveryTransport(
  input: GitHubInstallationDiscoveryInput,
  runtimeInput: GitHubInstallationDiscoveryRuntime = {},
): GitHubInstallationDiscoveryTransport {
  let captured: GitHubInstallationDiscoveryInput;
  let runtime: Runtime;
  let appJwt: CapturedLease;
  let installationToken: CapturedLease;
  try {
    captured = captureInput(input);
    runtime = captureRuntime(runtimeInput);
    appJwt = captureLease(
      captured.appJwt,
      "app-jwt",
      captured.installationId,
    );
    installationToken = captureLease(
      captured.installationToken,
      "installation-token",
      captured.installationId,
    );
  }
  catch (error) {
    throw error instanceof GitHubInstallationDiscoveryError
      ? error
      : fault("invalid_input");
  }

  let busy = false;
  let terminal = false;
  let startedAt: number | undefined;
  let callCount = 0;
  let nextPageIndex = 0;
  let nextCursor: string | null = null;
  let metadata: InstallationMetadata | undefined;
  let totalRepositories: number | undefined;
  let totalPages: number | undefined;
  const seenRepositoryIds = new Set<string>();
  const seenRepositoryLabels = new Set<string>();

  const readPage: GitHubInstallationDiscoveryTransport["readPage"] =
    async (pageInput) => {
      if (busy || terminal) throw fault("sequence_violation");
      let parsedInput: ReturnType<typeof parsePageInput>;
      try {
        parsedInput = parsePageInput(pageInput);
      }
      catch {
        return closeFailure(fault("sequence_violation"));
      }
      if (
        !parsedInput ||
        parsedInput.pageIndex !== nextPageIndex ||
        parsedInput.cursor !== nextCursor
      ) {
        return closeFailure(fault("sequence_violation"));
      }

      busy = true;
      if (startedAt === undefined) startedAt = now(runtime);
      try {
        if (parsedInput.pageIndex === 0) {
          metadata = await readInstallation(
            captured.installationId,
            appJwt,
            runtime,
            requestState,
          );
        }
        if (!metadata) return closeFailure(fault("sequence_violation"));

        const providerPage = parsedInput.pageIndex + 1;
        const repositoryResponse = await readRepositories(
          providerPage,
          installationToken,
          runtime,
          requestState,
        );
        if (totalRepositories === undefined) {
          totalRepositories = repositoryResponse.totalRepositories;
          totalPages = Math.max(
            1,
            Math.ceil(
              totalRepositories /
              GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE,
            ),
          );
          if (
            totalPages >
              GITHUB_INSTALLATION_DISCOVERY_MAX_REPOSITORY_PAGES
          ) {
            return closeFailure(fault("repository_overflow"));
          }
        }
        else if (
          repositoryResponse.totalRepositories !== totalRepositories
        ) {
          return closeFailure(fault("total_count_drift"));
        }
        if (totalPages === undefined || totalRepositories === undefined) {
          return closeFailure(fault("sequence_violation"));
        }

        const expectedLength = providerPage < totalPages
          ? GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE
          : totalRepositories -
            GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE *
            (totalPages - 1);
        if (
          providerPage > totalPages ||
          repositoryResponse.repositories.length !== expectedLength
        ) {
          return closeFailure(fault("page_length_mismatch"));
        }

        for (const repository of repositoryResponse.repositories) {
          const label = `${repository.owner}/${repository.name}`;
          if (
            seenRepositoryIds.has(repository.repositoryId) ||
            seenRepositoryLabels.has(label)
          ) {
            return closeFailure(fault("duplicate_repository"));
          }
          seenRepositoryIds.add(repository.repositoryId);
          seenRepositoryLabels.add(label);
        }

        const isFinal = providerPage === totalPages;
        const outputNextCursor = isFinal
          ? null
          : `${CURSOR_PREFIX}${providerPage + 1}`;
        if (isFinal) {
          const finalMetadata = await readInstallation(
            captured.installationId,
            appJwt,
            runtime,
            requestState,
          );
          if (!sameMetadata(metadata, finalMetadata)) {
            return closeFailure(fault("metadata_drift"));
          }
        }

        const page = freezePage({
          pageIndex: parsedInput.pageIndex,
          cursor: parsedInput.cursor,
          nextCursor: outputNextCursor,
          totalRepositories,
          metadata,
          repositories: repositoryResponse.repositories,
        });
        nextPageIndex += 1;
        nextCursor = outputNextCursor;
        if (isFinal) {
          terminal = true;
          const releaseError = releaseLeases(appJwt, installationToken);
          if (releaseError) throw releaseError;
        }
        return page;
      }
      catch (error) {
        return closeFailure(normalizeError(error));
      }
      finally {
        busy = false;
      }
    };

  function requestState(): Readonly<{
    callCount: number;
    totalDeadlineAt: number;
  }> {
    if (startedAt === undefined) throw fault("sequence_violation");
    if (callCount >= GITHUB_INSTALLATION_DISCOVERY_MAX_HTTP_CALLS) {
      throw fault("call_cap_exceeded");
    }
    callCount += 1;
    return {
      callCount,
      totalDeadlineAt:
        startedAt + GITHUB_INSTALLATION_DISCOVERY_TOTAL_TIMEOUT_MS,
    };
  }

  function closeFailure(error: GitHubInstallationDiscoveryError): never {
    terminal = true;
    const releaseError = releaseLeases(appJwt, installationToken);
    throw releaseError ?? error;
  }

  return Object.freeze({ readPage });
}

async function readInstallation(
  installationId: string,
  lease: CapturedLease,
  runtime: Runtime,
  requestState: () => Readonly<{
    callCount: number;
    totalDeadlineAt: number;
  }>,
): Promise<InstallationMetadata> {
  const response = await requestJson(
    "installation",
    `/app/installations/${installationId}`,
    "",
    lease,
    runtime,
    requestState(),
  );
  return parseInstallation(response, installationId);
}

async function readRepositories(
  page: number,
  lease: CapturedLease,
  runtime: Runtime,
  requestState: () => Readonly<{
    callCount: number;
    totalDeadlineAt: number;
  }>,
): Promise<Readonly<{
  totalRepositories: number;
  repositories: readonly RepositoryFixture[];
}>> {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > GITHUB_INSTALLATION_DISCOVERY_MAX_REPOSITORY_PAGES
  ) {
    throw fault("sequence_violation");
  }
  const response = await requestJson(
    "repositories",
    "/installation/repositories",
    `?per_page=${GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE}` +
      `&page=${page}`,
    lease,
    runtime,
    requestState(),
  );
  return parseRepositoryPage(response.value, lease.installationId);
}

async function requestJson(
  requestKind: GitHubInstallationDiscoveryHttpObservation["requestKind"],
  path: string,
  search: string,
  lease: CapturedLease,
  runtime: Runtime,
  state: Readonly<{
    callCount: number;
    totalDeadlineAt: number;
  }>,
): Promise<JsonResponse> {
  if (
    state.callCount < 1 ||
    state.callCount > GITHUB_INSTALLATION_DISCOVERY_MAX_HTTP_CALLS
  ) {
    throw fault("call_cap_exceeded");
  }
  const remaining = state.totalDeadlineAt - now(runtime);
  if (remaining <= 0) throw fault("deadline_exceeded");
  const timeoutMs = Math.min(
    GITHUB_INSTALLATION_DISCOVERY_REQUEST_TIMEOUT_MS,
    remaining,
  );
  const signal = runtime.timeoutSignal(timeoutMs);
  if (!isAbortSignal(signal)) throw fault("invalid_input");

  const secret = revealLease(lease, runtime);
  const url = `${GITHUB_INSTALLATION_DISCOVERY_API_ORIGIN}${path}${search}`;
  let request: Request;
  try {
    request = new Request(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${secret}`,
        "user-agent": GITHUB_INSTALLATION_DISCOVERY_USER_AGENT,
        "x-github-api-version": GITHUB_INSTALLATION_DISCOVERY_API_VERSION,
      },
      redirect: "error",
      signal,
    });
  }
  catch {
    throw fault("invalid_input");
  }
  if (
    request.method !== "GET" ||
    request.url !== url ||
    request.redirect !== "error"
  ) {
    throw fault("invalid_input");
  }

  let response: Response;
  try {
    response = await runtime.request(request);
  }
  catch {
    throw signal.aborted || now(runtime) >= state.totalDeadlineAt
      ? fault("deadline_exceeded")
      : fault("network_failure");
  }
  if (!(response instanceof Response)) throw fault("malformed_response");
  const rateLimit = parseRateLimit(response.headers);
  observe(runtime, {
    requestKind,
    status: response.status,
    rateLimit,
  });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await cancelResponse(response);
    throw fault("redirect_rejected", response.status);
  }
  if (response.status !== 200) {
    await cancelResponse(response);
    throw classifyStatus(response.status, rateLimit, requestKind);
  }
  const value = await readBoundedJson(response, signal, state, runtime);
  return {
    value,
    etag: parseEtag(response.headers.get("etag")),
  };
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  state: Readonly<{ totalDeadlineAt: number }>,
  runtime: Runtime,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (!contentType || !CONTENT_TYPE.test(contentType)) {
    await cancelResponse(response);
    throw fault("malformed_response");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!CONTENT_LENGTH.test(declared)) {
      await cancelResponse(response);
      throw fault("malformed_response");
    }
    if (Number(declared) > GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES) {
      await cancelResponse(response);
      throw fault("body_too_large");
    }
  }
  if (!response.body) throw fault("malformed_response");

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  }
  catch {
    throw fault("response_stream_failure");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      }
      catch {
        throw signal.aborted || now(runtime) >= state.totalDeadlineAt
          ? fault("deadline_exceeded")
          : fault("response_stream_failure");
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw fault("response_stream_failure");
      }
      total += result.value.byteLength;
      if (total > GITHUB_INSTALLATION_DISCOVERY_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        }
        catch {
          // The bounded failure remains authoritative.
        }
        throw fault("body_too_large");
      }
      if (result.value.byteLength > 0) chunks.push(result.value.slice());
      if (now(runtime) >= state.totalDeadlineAt) {
        throw fault("deadline_exceeded");
      }
    }
  }
  finally {
    try {
      reader.releaseLock();
    }
    catch {
      // No raw stream error or response object crosses the boundary.
    }
  }
  if (declared !== null && Number(declared) !== total) {
    throw fault("malformed_response");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw fault("malformed_response");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  }
  catch {
    throw fault("malformed_response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  }
  catch {
    throw fault("malformed_response");
  }
  if (now(runtime) >= state.totalDeadlineAt) {
    throw fault("deadline_exceeded");
  }
  return parsed;
}

function parseInstallation(
  response: JsonResponse,
  expectedInstallationId: string,
): InstallationMetadata {
  const value = plainRecord(response.value);
  if (!value) throw fault("malformed_response");
  const installationId = providerId(ownData(value, "id"));
  const repositorySelection = ownData(value, "repository_selection");
  const suspendedAt = ownData(value, "suspended_at");
  const updatedAt = ownData(value, "updated_at");
  if (
    !installationId ||
    installationId !== expectedInstallationId ||
    !member(GITHUB_REPOSITORY_SELECTIONS, repositorySelection) ||
    !(suspendedAt === null || timestamp(suspendedAt)) ||
    !timestamp(updatedAt)
  ) {
    throw fault("malformed_response");
  }
  if (suspendedAt !== null) throw fault("installation_suspended");
  const permissions = parsePermissions(ownData(value, "permissions"));
  return Object.freeze({
    installationId,
    repositorySelection,
    permissions,
    updatedAt,
    etag: response.etag,
  });
}

function parsePermissions(
  input: unknown,
): Readonly<Record<string, "read" | "write">> {
  const value = plainRecord(input);
  if (!value) throw fault("malformed_response");
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.some((key) => typeof key !== "string")) {
    throw fault("malformed_response");
  }
  const result: Record<string, "read" | "write"> = {};
  for (const key of keys as string[]) {
    const access = ownData(value, key);
    if (
      !GITHUB_REPOSITORY_PERMISSION_NAMES.includes(
        key as (typeof GITHUB_REPOSITORY_PERMISSION_NAMES)[number],
      )
    ) {
      throw fault("unsupported_permission");
    }
    if (access !== "read" && access !== "write") {
      throw fault("unsupported_permission");
    }
    if (key === "metadata" && access !== "read") {
      throw fault("missing_metadata_read");
    }
    result[key] = access;
  }
  if (result.metadata !== "read") throw fault("missing_metadata_read");
  const ordered: Record<string, "read" | "write"> = {};
  for (const name of GITHUB_REPOSITORY_PERMISSION_NAMES) {
    const access = result[name];
    if (access) ordered[name] = access;
  }
  return Object.freeze(ordered);
}

function parseRepositoryPage(
  input: unknown,
  installationId: string,
): Readonly<{
  totalRepositories: number;
  repositories: readonly RepositoryFixture[];
}> {
  const value = plainRecord(input);
  if (!value) throw fault("malformed_response");
  const total = ownData(value, "total_count");
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    throw fault("malformed_response");
  }
  if ((total as number) > GITHUB_INSTALLATION_FIXTURE_MAX_REPOSITORIES) {
    throw fault("repository_overflow");
  }
  const repositoryInputs = canonicalArray(
    ownData(value, "repositories"),
    GITHUB_INSTALLATION_DISCOVERY_REPOSITORIES_PER_PAGE,
  );
  if (!repositoryInputs) throw fault("malformed_response");
  const repositories: RepositoryFixture[] = [];
  for (const inputRepository of repositoryInputs) {
    const repository = plainRecord(inputRepository);
    const owner = repository &&
      plainRecord(ownData(repository, "owner"));
    const repositoryId = repository &&
      providerId(ownData(repository, "id"));
    const ownerLogin = owner && ownData(owner, "login");
    const name = repository && ownData(repository, "name");
    const fullName = repository && ownData(repository, "full_name");
    if (
      !repositoryId ||
      typeof ownerLogin !== "string" ||
      typeof name !== "string" ||
      typeof fullName !== "string"
    ) {
      throw fault("malformed_response");
    }
    const parsed = parseGitHubRepositoryInstallation({
      installationId,
      repositoryId,
      owner: ownerLogin,
      name,
    });
    if (
      !parsed ||
      asciiLower(fullName) !== `${parsed.owner}/${parsed.name}`
    ) {
      throw fault("malformed_response");
    }
    repositories.push(Object.freeze({
      repositoryId: parsed.repositoryId,
      owner: parsed.owner,
      name: parsed.name,
    }));
  }
  return Object.freeze({
    totalRepositories: total as number,
    repositories: Object.freeze(repositories),
  });
}

function freezePage(input: Readonly<{
  pageIndex: number;
  cursor: string | null;
  nextCursor: string | null;
  totalRepositories: number;
  metadata: InstallationMetadata;
  repositories: readonly RepositoryFixture[];
}>): Record<string, unknown> {
  return Object.freeze({
    specVersion: GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION,
    pageIndex: input.pageIndex,
    cursor: input.cursor,
    nextCursor: input.nextCursor,
    totalRepositories: input.totalRepositories,
    installation: Object.freeze({
      installationId: input.metadata.installationId,
      installationState: "active" as const,
      repositorySelection: input.metadata.repositorySelection,
      permissions: input.metadata.permissions,
    }),
    repositories: input.repositories,
  });
}

function sameMetadata(
  expected: InstallationMetadata,
  actual: InstallationMetadata,
): boolean {
  const expectedNames = Object.keys(expected.permissions);
  const actualNames = Object.keys(actual.permissions);
  return expected.installationId === actual.installationId &&
    expected.repositorySelection === actual.repositorySelection &&
    expected.updatedAt === actual.updatedAt &&
    expected.etag === actual.etag &&
    expectedNames.length === actualNames.length &&
    expectedNames.every(
      (name, index) =>
        name === actualNames[index] &&
        expected.permissions[name] === actual.permissions[name],
    );
}

function captureInput(input: unknown): GitHubInstallationDiscoveryInput {
  const value = exactRecord(input, [
    "appJwt",
    "installationId",
    "installationToken",
  ]);
  const installationId = value && ownData(value, "installationId");
  if (!value || !decimalId(installationId)) throw fault("invalid_input");
  return {
    installationId,
    appJwt: ownData(value, "appJwt") as
      GitHubInstallationDiscoveryCredentialLease,
    installationToken: ownData(value, "installationToken") as
      GitHubInstallationDiscoveryCredentialLease,
  };
}

function captureLease(
  input: unknown,
  expectedKind: CapturedLease["kind"],
  expectedInstallationId: string,
): CapturedLease {
  const value = exactRecord(input, [
    "expiresAtEpochMs",
    "installationId",
    "kind",
    "release",
    "reveal",
  ]);
  if (!value) throw fault("invalid_input");
  const kind = ownData(value, "kind");
  const installationId = ownData(value, "installationId");
  const expiresAtEpochMs = ownData(value, "expiresAtEpochMs");
  const reveal = ownData(value, "reveal");
  const release = ownData(value, "release");
  if (kind !== expectedKind) throw fault("lease_kind_mismatch");
  if (installationId !== expectedInstallationId) {
    throw fault("lease_installation_mismatch");
  }
  if (
    !Number.isSafeInteger(expiresAtEpochMs) ||
    (expiresAtEpochMs as number) <= 0 ||
    typeof reveal !== "function" ||
    typeof release !== "function"
  ) {
    throw fault("invalid_input");
  }
  return {
    kind: expectedKind,
    installationId,
    expiresAtEpochMs: expiresAtEpochMs as number,
    reveal: reveal as GitHubInstallationDiscoveryCredentialLease["reveal"],
    release: release as GitHubInstallationDiscoveryCredentialLease["release"],
    secret: undefined,
    released: false,
  };
}

function captureRuntime(input: unknown): Runtime {
  const value = exactRecord(input, [
    "now",
    "observe",
    "request",
    "timeoutSignal",
  ], true);
  if (!value) throw fault("invalid_input");
  const request = ownData(value, "request");
  const nowFunction = ownData(value, "now");
  const timeoutSignal = ownData(value, "timeoutSignal");
  const observeFunction = ownData(value, "observe");
  if (
    request !== undefined && typeof request !== "function" ||
    nowFunction !== undefined && typeof nowFunction !== "function" ||
    timeoutSignal !== undefined && typeof timeoutSignal !== "function" ||
    observeFunction !== undefined && typeof observeFunction !== "function"
  ) {
    throw fault("invalid_input");
  }
  return {
    request: request
      ? request as Runtime["request"]
      : (requestValue) => globalThis.fetch(requestValue),
    now: nowFunction
      ? nowFunction as Runtime["now"]
      : () => Date.now(),
    timeoutSignal: timeoutSignal
      ? timeoutSignal as Runtime["timeoutSignal"]
      : (timeoutMs) => AbortSignal.timeout(timeoutMs),
    observe: observeFunction
      ? observeFunction as Runtime["observe"]
      : () => undefined,
  };
}

function parsePageInput(
  input: unknown,
): Readonly<{ pageIndex: number; cursor: string | null }> | undefined {
  const value = exactRecord(input, ["cursor", "pageIndex"]);
  const pageIndex = value && ownData(value, "pageIndex");
  const cursor = value && ownData(value, "cursor");
  if (
    !value ||
    !Number.isSafeInteger(pageIndex) ||
    (pageIndex as number) < 0 ||
    (pageIndex as number) >=
      GITHUB_INSTALLATION_DISCOVERY_MAX_REPOSITORY_PAGES ||
    !(cursor === null ||
      typeof cursor === "string" &&
      cursor === `${CURSOR_PREFIX}${(pageIndex as number) + 1}`)
  ) {
    return undefined;
  }
  return { pageIndex: pageIndex as number, cursor };
}

function revealLease(lease: CapturedLease, runtime: Runtime): string {
  if (
    lease.released ||
    lease.expiresAtEpochMs <=
      now(runtime) + GITHUB_INSTALLATION_DISCOVERY_LEASE_SKEW_MS
  ) {
    throw fault("lease_expired");
  }
  if (lease.secret !== undefined) return lease.secret;
  let secret: unknown;
  try {
    secret = lease.reveal();
  }
  catch {
    throw fault("lease_unavailable");
  }
  if (typeof secret !== "string" || !TOKEN.test(secret)) {
    throw fault("lease_unavailable");
  }
  lease.secret = secret;
  return secret;
}

function releaseLeases(...leases: CapturedLease[]):
GitHubInstallationDiscoveryError | undefined {
  let failed = false;
  for (const lease of leases) {
    if (lease.released) continue;
    lease.released = true;
    lease.secret = undefined;
    try {
      lease.release();
    }
    catch {
      failed = true;
    }
  }
  return failed ? fault("lease_release_failed") : undefined;
}

function classifyStatus(
  status: number,
  rateLimit: GitHubInstallationDiscoveryRateLimit,
  requestKind: GitHubInstallationDiscoveryHttpObservation["requestKind"],
): GitHubInstallationDiscoveryError {
  if (
    status === 429 ||
    status === 403 &&
      (rateLimit.remaining === 0 ||
        rateLimit.retryAfterSeconds !== undefined)
  ) {
    return fault("rate_limited", status, rateLimit);
  }
  if (status === 401 || status === 403) {
    return fault("authentication_rejected", status);
  }
  if (status === 400 || status === 410) {
    return fault("api_version_unsupported", status);
  }
  if (status === 404 && requestKind === "installation") {
    return fault("installation_not_found", status);
  }
  if (status >= 500 && status <= 599) {
    return fault("upstream_failure", status);
  }
  return fault("unexpected_status", status);
}

function parseRateLimit(headers: Headers): GitHubInstallationDiscoveryRateLimit {
  return Object.freeze({
    limit: nonNegativeHeader(headers.get("x-ratelimit-limit")),
    remaining: nonNegativeHeader(headers.get("x-ratelimit-remaining")),
    resetAtEpochSeconds: nonNegativeHeader(headers.get("x-ratelimit-reset")),
    retryAfterSeconds: nonNegativeHeader(headers.get("retry-after")),
  });
}

function nonNegativeHeader(value: string | null): number | undefined {
  if (value === null || !CONTENT_LENGTH.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseEtag(value: string | null): string | null {
  if (value === null) return null;
  if (
    value.length < 1 ||
    value.length > 256 ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw fault("malformed_response");
  }
  return value;
}

function observe(
  runtime: Runtime,
  observation: GitHubInstallationDiscoveryHttpObservation,
): void {
  try {
    runtime.observe(Object.freeze({
      requestKind: observation.requestKind,
      status: observation.status,
      rateLimit: observation.rateLimit,
    }));
  }
  catch {
    // Observation is deliberately non-authoritative and receives no secret.
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  }
  catch {
    // The closed status classification remains authoritative.
  }
}

function now(runtime: Runtime): number {
  let value: unknown;
  try {
    value = runtime.now();
  }
  catch {
    throw fault("deadline_exceeded");
  }
  if (!Number.isFinite(value) || (value as number) < 0) {
    throw fault("deadline_exceeded");
  }
  return value as number;
}

function providerId(value: unknown): string | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? String(value)
    : undefined;
}

function decimalId(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL_ID.test(value)) return false;
  return value.length < MAX_GITHUB_ID.length ||
    value.length === MAX_GITHUB_ID.length && value <= MAX_GITHUB_ID;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 35 &&
    Number.isFinite(Date.parse(value));
}

function asciiLower(value: string): string | undefined {
  return value.length > 0 &&
      [...value].every((character) => (character.codePointAt(0) ?? 128) < 128)
    ? value.toLowerCase()
    : undefined;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function member<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function canonicalArray(
  input: unknown,
  maximum: number,
): readonly unknown[] | undefined {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > maximum
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== input.length + 1 || keys.at(-1) !== "length") {
    return undefined;
  }
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (keys[index] !== String(index)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    values.push(descriptor.value);
  }
  return values;
}

function exactRecord(
  input: unknown,
  expected: readonly string[],
  partial = false,
): Readonly<Record<string, unknown>> | undefined {
  const value = plainRecord(input);
  if (!value) return undefined;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    !keys.every((key) => expected.includes(key as string)) ||
    !partial && keys.length !== expected.length
  ) {
    return undefined;
  }
  return value;
}

function plainRecord(
  input: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
  }
  return input as Readonly<Record<string, unknown>>;
}

function ownData(
  value: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function normalizeError(error: unknown): GitHubInstallationDiscoveryError {
  return error instanceof GitHubInstallationDiscoveryError
    ? error
    : fault("malformed_response");
}

function fault(
  code: ConstructorParameters<typeof GitHubInstallationDiscoveryError>[0],
  status?: number,
  rateLimit?: GitHubInstallationDiscoveryRateLimit,
): GitHubInstallationDiscoveryError {
  return new GitHubInstallationDiscoveryError(code, { status, rateLimit });
}
