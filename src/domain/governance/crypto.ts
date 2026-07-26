import { canonicalJson } from "./canonical-json";

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacSha256Hex(
  secret: string,
  value: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
