export const ENGINE_RUN_EXCERPT_SCHEMA_VERSION = 1 as const;
export const ENGINE_RUN_EXCERPT_MAX_BYTES = 1_024;

export type EngineRunExcerptStreamFacts = Readonly<{
  bytes: number;
  excerptBytes: number;
  sha256: string;
  truncated: boolean;
}>;

export type EngineRunExcerptReceiptFacts = Readonly<{
  excerptRef: string;
  excerptSha256: string;
  receiptSha256: string;
  recordedAt: string;
  stdout: EngineRunExcerptStreamFacts;
  stderr: EngineRunExcerptStreamFacts;
}>;

export type EngineRunExcerptAbsent = Readonly<{
  schemaVersion: typeof ENGINE_RUN_EXCERPT_SCHEMA_VERSION;
  runId: string;
  state: "absent";
}>;

export type EngineRunExcerptErased = Readonly<{
  schemaVersion: typeof ENGINE_RUN_EXCERPT_SCHEMA_VERSION;
  runId: string;
  state: "erased";
  erasedAt: string;
  receipt: EngineRunExcerptReceiptFacts;
}>;

export type EngineRunExcerptStored = Readonly<{
  schemaVersion: typeof ENGINE_RUN_EXCERPT_SCHEMA_VERSION;
  runId: string;
  state: "stored";
  encoding: "base64url";
  interpretation: "opaque_bytes";
  stdoutBase64Url: string;
  stderrBase64Url: string;
  receipt: EngineRunExcerptReceiptFacts;
}>;

export type EngineRunExcerptView =
  | EngineRunExcerptAbsent
  | EngineRunExcerptErased
  | EngineRunExcerptStored;
