import { hmacSha256Hex } from "@/src/domain/governance/crypto";

export const LOCAL_MESSAGE_INTEGRITY_KEY =
  "nexusos-local-development-integrity-key-not-for-production";

export async function messageIntegrityHash(
  secret: string,
  organizationId: string,
  messageId: string,
  bodyText: string,
): Promise<string> {
  return hmacSha256Hex(
    secret,
    `${organizationId}\u0000${messageId}\u0000${bodyText}`,
  );
}
