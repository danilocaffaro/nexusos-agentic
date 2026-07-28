import type {
  EngineRunCreationId,
} from "@/src/contracts/runs";
import type {
  EngineRunCreateRequest,
} from "@/src/domain/runners/engine-control-plane";
import { sha256Bytes } from "@/src/domain/governance/crypto";

export const ENGINE_RUN_CREATION_ID_PATTERN = /^ecr_[0-9a-f]{32}$/u;
export const ENGINE_RUN_NOT_CREATED_PROOF_ID_PATTERN =
  /^ncp_[0-9a-f]{32}$/u;
export const ENGINE_RUN_CREATION_RETENTION_MS =
  30 * 24 * 60 * 60_000;

export function parseEngineRunCreationId(
  value: string | null | undefined,
): EngineRunCreationId | undefined {
  return value && ENGINE_RUN_CREATION_ID_PATTERN.test(value)
    ? (value as EngineRunCreationId)
    : undefined;
}

export async function hashEngineRunCreationRequest(
  input: EngineRunCreateRequest,
): Promise<string> {
  const domainSeparated = [
    "nexus:engine-creation:v1",
    input.assignedRunnerId,
    input.engine,
    input.promptSha256,
  ].join("|");
  return (
    await sha256Bytes(new TextEncoder().encode(domainSeparated))
  ).hex;
}

export function generateEngineRunNotCreatedProofId(): `ncp_${string}` {
  return `ncp_${randomHex(16)}`;
}

export function engineRunCreationRetainUntil(createdAt: string): string {
  return new Date(
    Date.parse(createdAt) + ENGINE_RUN_CREATION_RETENTION_MS,
  ).toISOString();
}

function randomHex(byteLength: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(byteLength)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
