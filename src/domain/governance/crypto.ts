import { canonicalJson } from "./canonical-json";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Bytes(
  value: Uint8Array,
): Promise<{ hex: string; base64: string }> {
  const input = value.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", input),
  );
  return { hex: toHex(digest), base64: toBase64(digest) };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return (await sha256Bytes(bytes)).hex;
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
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
  );
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
