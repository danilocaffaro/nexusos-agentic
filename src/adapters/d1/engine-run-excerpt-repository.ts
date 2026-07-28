import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import {
  ENGINE_RUN_EXCERPT_MAX_BYTES,
  ENGINE_RUN_EXCERPT_SCHEMA_VERSION,
  type EngineRunExcerptReceiptFacts,
  type EngineRunExcerptView,
} from "@/src/contracts/engine-run-excerpts";
import {
  ENGINE_STDERR_MAX_BYTES,
  ENGINE_STDOUT_MAX_BYTES,
} from "@/src/contracts/execution-engines";
import { sha256Bytes } from "@/src/domain/governance/crypto";
import {
  ENGINE_EXCERPT_REF_PATTERN,
  ENGINE_SHA256_PATTERN,
  ENGINE_TIMESTAMP_PATTERN,
  unframeEngineExcerpts,
} from "@/src/domain/runners/execution-engine";
import { RUN_ID_PATTERN } from "@/src/domain/runners/lease-protocol";

const CIPHER_VERSION = 1;

export type EngineRunExcerptReadPorts = Readonly<{
  authorizeOwner: (identity: RequestIdentity) => Promise<void>;
  loadSnapshot: (
    organizationId: string,
    runId: string,
  ) => Promise<EngineRunExcerptStorageSnapshot | null>;
  notFoundError: () => Error;
  cryptoError: () => Error;
}>;

export type EngineRunExcerptStorageSnapshot = {
  run_id: string;
  receipt_run_id: string | null;
  excerpt_run_id: string | null;
  receipt_excerpt_ref: string | null;
  receipt_excerpt_sha256: string | null;
  receipt_sha256: string | null;
  recorded_at: string | null;
  receipt_stdout_bytes: number | null;
  receipt_stdout_sha256: string | null;
  receipt_stdout_truncated: number | null;
  receipt_stdout_excerpt_bytes: number | null;
  receipt_stderr_bytes: number | null;
  receipt_stderr_sha256: string | null;
  receipt_stderr_truncated: number | null;
  receipt_stderr_excerpt_bytes: number | null;
  payload_excerpt_ref: string | null;
  payload_excerpt_sha256: string | null;
  cipher_version: number | null;
  key_id: string | null;
  iv: ArrayBuffer | ArrayBufferView | number[] | null;
  ciphertext: ArrayBuffer | ArrayBufferView | number[] | null;
  tag: ArrayBuffer | ArrayBufferView | number[] | null;
  payload_stdout_excerpt_bytes: number | null;
  payload_stderr_excerpt_bytes: number | null;
  payload_created_at: string | null;
  erased_at: string | null;
};

export async function readEngineRunExcerpt(
  identity: RequestIdentity,
  runId: string,
): Promise<EngineRunExcerptView> {
  const [
    { getD1 },
    { requireWorkspaceOwner, WorkspaceRepositoryError },
  ] = await Promise.all([
    import("@/db"),
    import("./workspace-repository"),
  ]);
  return readEngineRunExcerptWithPorts(
    identity,
    runId,
    async () => {
      const [
        { env },
        cipherModule,
      ] = await Promise.all([
        import("cloudflare:workers"),
        import("../crypto/" + "web-crypto-" + "prompt-cipher") as
          Promise<ExcerptCipherModule>,
      ]);
      const keyring = cipherModule.resolvePromptCipherKeyring({
        allowLocalIdentity: env.NEXUS_ALLOW_LOCAL_IDENTITY === "1",
        serialized: env.NEXUS_PROMPT_CIPHER_KEYS,
      });
      return new cipherModule.WebCryptoPromptCipher(keyring);
    },
    {
      authorizeOwner: requireWorkspaceOwner,
      loadSnapshot: (organizationId, selectedRunId) =>
        loadEngineRunExcerptSnapshot(
          getD1(),
          organizationId,
          selectedRunId,
        ),
      notFoundError: () =>
        new WorkspaceRepositoryError("engine_run_not_found", 404),
      cryptoError: () =>
        new WorkspaceRepositoryError(
          "prompt_cipher_key_unavailable",
          503,
        ),
    },
  );
}

export async function readEngineRunExcerptWithPorts(
  identity: RequestIdentity,
  runId: string,
  resolveCipher: () => ExcerptCipher | Promise<ExcerptCipher>,
  ports: EngineRunExcerptReadPorts,
): Promise<EngineRunExcerptView> {
  // Owner/admin authorization is deliberately completed before the only
  // port allowed to select protected payload columns.
  await ports.authorizeOwner(identity);
  if (!RUN_ID_PATTERN.test(runId)) throw ports.notFoundError();

  const snapshot = await ports.loadSnapshot(identity.organizationId, runId);
  if (!snapshot) throw ports.notFoundError();
  try {
    return await projectEngineRunExcerpt(
      identity.organizationId,
      runId,
      snapshot,
      resolveCipher,
    );
  } catch (error) {
    if (error instanceof EngineRunExcerptStorageError) {
      throw ports.cryptoError();
    }
    throw error;
  }
}

async function loadEngineRunExcerptSnapshot(
  d1: D1Database,
  organizationId: string,
  runId: string,
): Promise<EngineRunExcerptStorageSnapshot | null> {
  return d1
    .prepare(
      `SELECT
         run.id AS run_id,
         receipt.run_id AS receipt_run_id,
         excerpt.run_id AS excerpt_run_id,
         receipt.excerpt_ref AS receipt_excerpt_ref,
         receipt.excerpt_sha256 AS receipt_excerpt_sha256,
         receipt.receipt_sha256,
         receipt.recorded_at,
         receipt.stdout_bytes AS receipt_stdout_bytes,
         receipt.stdout_sha256 AS receipt_stdout_sha256,
         receipt.stdout_truncated AS receipt_stdout_truncated,
         receipt.stdout_excerpt_bytes AS receipt_stdout_excerpt_bytes,
         receipt.stderr_bytes AS receipt_stderr_bytes,
         receipt.stderr_sha256 AS receipt_stderr_sha256,
         receipt.stderr_truncated AS receipt_stderr_truncated,
         receipt.stderr_excerpt_bytes AS receipt_stderr_excerpt_bytes,
         excerpt.excerpt_ref AS payload_excerpt_ref,
         excerpt.excerpt_sha256 AS payload_excerpt_sha256,
         excerpt.cipher_version,
         excerpt.key_id,
         excerpt.iv,
         excerpt.ciphertext,
         excerpt.tag,
         excerpt.stdout_excerpt_bytes AS payload_stdout_excerpt_bytes,
         excerpt.stderr_excerpt_bytes AS payload_stderr_excerpt_bytes,
         excerpt.created_at AS payload_created_at,
         excerpt.erased_at
       FROM runs AS run
       LEFT JOIN run_engine_receipts AS receipt
         ON receipt.run_id = run.id
        AND receipt.organization_id = run.organization_id
       LEFT JOIN run_engine_excerpts AS excerpt
         ON excerpt.run_id = run.id
        AND excerpt.organization_id = run.organization_id
       WHERE run.id = ? AND run.organization_id = ?
         AND run.kind = 'engine_prompt'
       LIMIT 1`,
    )
    .bind(runId, organizationId)
    .first<EngineRunExcerptStorageSnapshot>();
}

async function projectEngineRunExcerpt(
  organizationId: string,
  runId: string,
  snapshot: EngineRunExcerptStorageSnapshot,
  resolveCipher: () => ExcerptCipher | Promise<ExcerptCipher>,
): Promise<EngineRunExcerptView> {
  if (snapshot.run_id !== runId) throw cryptoUnavailable();
  if (
    snapshot.receipt_run_id === null &&
    snapshot.excerpt_run_id === null
  ) {
    return deepFreeze({
      schemaVersion: ENGINE_RUN_EXCERPT_SCHEMA_VERSION,
      runId,
      state: "absent",
    });
  }
  if (
    snapshot.receipt_run_id !== runId ||
    snapshot.excerpt_run_id !== runId
  ) {
    throw cryptoUnavailable();
  }

  const receipt = receiptFacts(snapshot);
  if (!payloadPinsMatch(snapshot, receipt)) throw cryptoUnavailable();

  if (snapshot.erased_at !== null) {
    if (
      !isCanonicalTimestamp(snapshot.erased_at) ||
      !isCanonicalTimestamp(snapshot.payload_created_at) ||
      snapshot.erased_at < snapshot.payload_created_at ||
      snapshot.key_id !== null ||
      snapshot.iv !== null ||
      snapshot.ciphertext !== null ||
      snapshot.tag !== null
    ) {
      throw cryptoUnavailable();
    }
    return deepFreeze({
      schemaVersion: ENGINE_RUN_EXCERPT_SCHEMA_VERSION,
      runId,
      state: "erased",
      erasedAt: snapshot.erased_at,
      receipt,
    });
  }

  let framed: Uint8Array;
  try {
    if (
      snapshot.cipher_version !== CIPHER_VERSION ||
      snapshot.key_id === null ||
      snapshot.iv === null ||
      snapshot.ciphertext === null ||
      snapshot.tag === null
    ) {
      throw cryptoUnavailable();
    }
    const ciphertext = protectedBlob(snapshot.ciphertext);
    if (
      ciphertext.byteLength !==
        2 + receipt.stdout.excerptBytes + receipt.stderr.excerptBytes
    ) {
      throw cryptoUnavailable();
    }
    const cipher = await resolveCipher();
    framed = await cipher.decrypt(
      {
        cipherVersion: CIPHER_VERSION,
        keyId: snapshot.key_id,
        iv: protectedBlob(snapshot.iv),
        ciphertext,
        tag: protectedBlob(snapshot.tag),
      },
      {
        organizationId,
        payloadRef: receipt.excerptRef,
        runId,
      },
    );
  } catch {
    throw cryptoUnavailable();
  }

  let stdout: Uint8Array | undefined;
  let stderr: Uint8Array | undefined;
  try {
    const digest = await sha256Bytes(framed);
    const streams = unframeEngineExcerpts(framed);
    stdout = streams.stdout;
    stderr = streams.stderr;
    if (
      digest.hex !== receipt.excerptSha256 ||
      stdout.byteLength !== receipt.stdout.excerptBytes ||
      stderr.byteLength !== receipt.stderr.excerptBytes
    ) {
      throw cryptoUnavailable();
    }
    return deepFreeze({
      schemaVersion: ENGINE_RUN_EXCERPT_SCHEMA_VERSION,
      runId,
      state: "stored",
      encoding: "base64url",
      interpretation: "opaque_bytes",
      stdoutBase64Url: encodeBase64Url(stdout),
      stderrBase64Url: encodeBase64Url(stderr),
      receipt,
    });
  } catch {
    throw cryptoUnavailable();
  } finally {
    stdout?.fill(0);
    stderr?.fill(0);
    framed.fill(0);
  }
}

function receiptFacts(
  snapshot: EngineRunExcerptStorageSnapshot,
): EngineRunExcerptReceiptFacts {
  const stdout = streamFacts(
    snapshot.receipt_stdout_bytes,
    snapshot.receipt_stdout_excerpt_bytes,
    snapshot.receipt_stdout_sha256,
    snapshot.receipt_stdout_truncated,
    ENGINE_STDOUT_MAX_BYTES,
  );
  const stderr = streamFacts(
    snapshot.receipt_stderr_bytes,
    snapshot.receipt_stderr_excerpt_bytes,
    snapshot.receipt_stderr_sha256,
    snapshot.receipt_stderr_truncated,
    ENGINE_STDERR_MAX_BYTES,
  );
  if (
    !ENGINE_EXCERPT_REF_PATTERN.test(snapshot.receipt_excerpt_ref ?? "") ||
    !ENGINE_SHA256_PATTERN.test(snapshot.receipt_excerpt_sha256 ?? "") ||
    !ENGINE_SHA256_PATTERN.test(snapshot.receipt_sha256 ?? "") ||
    !isCanonicalTimestamp(snapshot.recorded_at) ||
    stdout.excerptBytes + stderr.excerptBytes > ENGINE_RUN_EXCERPT_MAX_BYTES
  ) {
    throw cryptoUnavailable();
  }
  return deepFreeze({
    excerptRef: snapshot.receipt_excerpt_ref as string,
    excerptSha256: snapshot.receipt_excerpt_sha256 as string,
    receiptSha256: snapshot.receipt_sha256 as string,
    recordedAt: snapshot.recorded_at as string,
    stdout,
    stderr,
  });
}

function streamFacts(
  bytes: number | null,
  excerptBytes: number | null,
  sha256: string | null,
  truncated: number | null,
  maximumBytes: number,
) {
  if (
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 0 ||
    (bytes as number) > maximumBytes ||
    !Number.isSafeInteger(excerptBytes) ||
    (excerptBytes as number) < 0 ||
    (excerptBytes as number) > ENGINE_RUN_EXCERPT_MAX_BYTES ||
    (excerptBytes as number) > (bytes as number) ||
    !ENGINE_SHA256_PATTERN.test(sha256 ?? "") ||
    ![0, 1].includes(truncated as number) ||
    (truncated === 1) !== ((bytes as number) > (excerptBytes as number))
  ) {
    throw cryptoUnavailable();
  }
  return deepFreeze({
    bytes: bytes as number,
    excerptBytes: excerptBytes as number,
    sha256: sha256 as string,
    truncated: truncated === 1,
  });
}

function payloadPinsMatch(
  snapshot: EngineRunExcerptStorageSnapshot,
  receipt: EngineRunExcerptReceiptFacts,
): boolean {
  return (
    snapshot.payload_excerpt_ref === receipt.excerptRef &&
    snapshot.payload_excerpt_sha256 === receipt.excerptSha256 &&
    snapshot.payload_stdout_excerpt_bytes === receipt.stdout.excerptBytes &&
    snapshot.payload_stderr_excerpt_bytes === receipt.stderr.excerptBytes &&
    isCanonicalTimestamp(snapshot.payload_created_at) &&
    snapshot.payload_created_at === receipt.recordedAt
  );
}

function protectedBlob(
  value: ArrayBuffer | ArrayBufferView | number[],
): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ),
    );
  }
  if (
    Array.isArray(value) &&
    value.every(
      (byte) =>
        Number.isSafeInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  throw cryptoUnavailable();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !ENGINE_TIMESTAMP_PATTERN.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function cryptoUnavailable(): EngineRunExcerptStorageError {
  return new EngineRunExcerptStorageError();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

class EngineRunExcerptStorageError extends Error {
  constructor() {
    super("Engine run excerpt storage is unavailable.");
    this.name = "EngineRunExcerptStorageError";
  }
}

type ExcerptCipher = {
  decrypt(
    envelope: {
      cipherVersion: 1;
      ciphertext: Uint8Array;
      iv: Uint8Array;
      keyId: string;
      tag: Uint8Array;
    },
    context: {
      organizationId: string;
      payloadRef: string;
      runId: string;
    },
  ): Promise<Uint8Array>;
};

type ExcerptCipherModule = {
  resolvePromptCipherKeyring(input: {
    allowLocalIdentity: boolean;
    serialized: string | undefined;
  }): unknown;
  WebCryptoPromptCipher: new (keyring: unknown) => ExcerptCipher;
};
