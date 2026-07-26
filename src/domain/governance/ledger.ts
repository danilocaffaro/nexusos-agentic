import {
  GENESIS_HASH,
  type LedgerEntry,
  type LedgerEvent,
} from "../../contracts/governance";
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./crypto";

type HashableEntry = LedgerEvent & {
  sequence: number;
  previousHash: string;
};

function projectHashableEntry(
  event: LedgerEvent,
  sequence: number,
  previousHash: string,
): HashableEntry {
  return {
    id: event.id,
    organizationId: event.organizationId,
    kind: event.kind,
    actorId: event.actorId,
    occurredAt: event.occurredAt,
    payloadHash: event.payloadHash,
    ...(event.payloadRef !== undefined ? { payloadRef: event.payloadRef } : {}),
    ...(event.intentId !== undefined ? { intentId: event.intentId } : {}),
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    sequence,
    previousHash,
  };
}

export async function appendLedgerEntry(
  previous: LedgerEntry | undefined,
  event: LedgerEvent,
): Promise<LedgerEntry> {
  if (previous && previous.organizationId !== event.organizationId) {
    throw new TypeError("Ledger entries cannot cross organization boundaries");
  }

  const hashable = projectHashableEntry(
    event,
    previous ? previous.sequence + 1 : 1,
    previous?.hash ?? GENESIS_HASH,
  );

  return {
    ...hashable,
    hash: await sha256Hex(canonicalJson(hashable)),
  };
}

export async function recomputeLedgerEntryHash(
  entry: LedgerEntry,
): Promise<string> {
  return sha256Hex(
    canonicalJson(
      projectHashableEntry(
        entry,
        entry.sequence,
        entry.previousHash,
      ),
    ),
  );
}

export type LedgerVerification =
  | { valid: true; headHash: string; entries: number }
  | {
      valid: false;
      entryId: string;
      sequence: number;
      reason: "sequence" | "previous_hash" | "content_hash" | "organization";
    };

export async function verifyLedgerChain(
  entries: LedgerEntry[],
): Promise<LedgerVerification> {
  let expectedPreviousHash = GENESIS_HASH;
  let organizationId: string | undefined;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expectedSequence = index + 1;
    if (entry.sequence !== expectedSequence) {
      return failure(entry, "sequence");
    }
    if (organizationId && entry.organizationId !== organizationId) {
      return failure(entry, "organization");
    }
    organizationId ??= entry.organizationId;
    if (entry.previousHash !== expectedPreviousHash) {
      return failure(entry, "previous_hash");
    }

    const calculated = await recomputeLedgerEntryHash(entry);
    if (calculated !== entry.hash) {
      return failure(entry, "content_hash");
    }
    expectedPreviousHash = entry.hash;
  }

  return {
    valid: true,
    headHash: entries.at(-1)?.hash ?? GENESIS_HASH,
    entries: entries.length,
  };
}

function failure(
  entry: LedgerEntry,
  reason: Exclude<LedgerVerification, { valid: true }>["reason"],
): LedgerVerification {
  return {
    valid: false,
    entryId: entry.id,
    sequence: entry.sequence,
    reason,
  };
}
