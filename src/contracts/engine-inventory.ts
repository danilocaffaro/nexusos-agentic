import type {
  EngineProbe,
  ExecutionEngineName,
} from "./execution-engines";

export type EngineFileKind = "directory" | "file" | "other" | "symlink";

export type EngineFileFacts = {
  dev: string;
  gid: number;
  ino: string;
  kind: EngineFileKind;
  mode: number;
  mtimeMs: number;
  size: number;
  uid: number;
};

export interface EngineFilesystemPort {
  lstat(path: string): Promise<EngineFileFacts>;
  openNoFollow(path: string): Promise<{
    close(): Promise<void>;
    facts: EngineFileFacts;
  }>;
  realpath(path: string): Promise<string>;
}

export type EngineProbeProcessInput = {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  executableRealPath: string;
  maxStderrBytes: number;
  maxStdoutBytes: number;
  timeoutMs: number;
};

export type EngineProbeProcessResult = {
  errorCode?: string;
  exitCode: number | null;
  overflowed: boolean;
  stderr: Uint8Array;
  stdout: Uint8Array;
  timedOut: boolean;
};

export interface EngineProcessPort {
  runBounded(
    input: EngineProbeProcessInput,
  ): Promise<EngineProbeProcessResult>;
}

export type EngineLocalConfiguration = {
  engines: Partial<
    Record<ExecutionEngineName, { executablePath: string }>
  >;
  schemaVersion: 1;
};

export type EngineInventorySnapshot = {
  changeFingerprint: string;
  probes: EngineProbe[];
  truncated: boolean;
};
