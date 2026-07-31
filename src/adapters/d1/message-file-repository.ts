import { env } from "cloudflare:workers";
import { getD1 } from "@/db";
import type { RequestIdentity } from "@/src/adapters/identity/request-identity";
import { requireWorkspaceMember } from "@/src/adapters/d1/workspace-repository";
import type { MessageAttachment } from "@/src/contracts/collaboration";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 3;
const FILE_NAME_HEADER = "x-nexus-file-name";

const FILE_TYPES: Record<
  string,
  { mediaType: string; validate: (bytes: Uint8Array) => boolean }
> = {
  ".txt": { mediaType: "text/plain; charset=utf-8", validate: validText },
  ".md": { mediaType: "text/markdown; charset=utf-8", validate: validText },
  ".csv": { mediaType: "text/csv; charset=utf-8", validate: validText },
  ".json": {
    mediaType: "application/json",
    validate: (bytes) => validText(bytes) && validJson(bytes),
  },
  ".pdf": {
    mediaType: "application/pdf",
    validate: (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
  ".png": {
    mediaType: "image/png",
    validate: (bytes) =>
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  ".jpg": { mediaType: "image/jpeg", validate: validJpeg },
  ".jpeg": { mediaType: "image/jpeg", validate: validJpeg },
  ".gif": { mediaType: "image/gif", validate: validGif },
  ".webp": { mediaType: "image/webp", validate: validWebp },
  ".zip": { mediaType: "application/zip", validate: validZip },
  ".docx": {
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    validate: validZip,
  },
  ".xlsx": {
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    validate: validZip,
  },
  ".pptx": {
    mediaType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    validate: validZip,
  },
};

export class MessageFileRepositoryError extends Error {
  constructor(
    readonly code:
      | "attachment_conversation_membership_required"
      | "attachment_not_found"
      | "file_content_invalid"
      | "file_name_invalid"
      | "file_storage_unavailable"
      | "file_too_large"
      | "file_type_not_allowed"
      | "invalid_attachment_ids"
      | "staged_attachment_not_available",
    readonly status: number,
  ) {
    super(code);
    this.name = "MessageFileRepositoryError";
  }
}

export async function stageConversationFile(
  identity: RequestIdentity,
  conversationId: string,
  request: Request,
): Promise<MessageAttachment> {
  await requireWorkspaceMember(identity);
  await requireWritableConversationMember(identity, conversationId);
  const originalName = parseFileName(request.headers.get(FILE_NAME_HEADER));
  const extension = fileExtension(originalName);
  const fileType = FILE_TYPES[extension];
  if (!fileType) {
    throw new MessageFileRepositoryError("file_type_not_allowed", 415);
  }
  if (request.headers.get("content-encoding")) {
    throw new MessageFileRepositoryError("file_content_invalid", 400);
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    (declaredLength < 1 || declaredLength > MAX_FILE_BYTES)
  ) {
    throw new MessageFileRepositoryError("file_too_large", 413);
  }

  const bytes = await readBoundedBody(request, MAX_FILE_BYTES);
  if (!fileType.validate(bytes)) {
    throw new MessageFileRepositoryError("file_content_invalid", 415);
  }
  if (!env.FILES) {
    throw new MessageFileRepositoryError("file_storage_unavailable", 503);
  }

  const id = crypto.randomUUID();
  const objectKey =
    `${identity.organizationId}/conversations/${conversationId}/${id}`;
  const contentHash = await sha256Base64Url(bytes);
  const now = new Date().toISOString();
  await env.FILES.put(objectKey, exactArrayBuffer(bytes), {
    httpMetadata: { contentType: fileType.mediaType },
    customMetadata: {
      contentHash,
      attachmentId: id,
    },
  });
  try {
    await getD1()
      .prepare(
        `INSERT INTO message_attachments (
           id, organization_id, conversation_id, uploader_id, object_key,
           original_name, media_type, byte_size, content_hash,
           scan_status, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_scanned', 'staged', ?)`,
      )
      .bind(
        id,
        identity.organizationId,
        conversationId,
        identity.id,
        objectKey,
        originalName,
        fileType.mediaType,
        bytes.byteLength,
        contentHash,
        now,
      )
      .run();
  } catch (error) {
    await env.FILES.delete(objectKey).catch(() => undefined);
    throw error;
  }
  return {
    id,
    originalName,
    mediaType: fileType.mediaType,
    byteSize: bytes.byteLength,
    contentHash,
    scanStatus: "not_scanned",
    downloadUrl: `/api/files/${id}`,
  };
}

export async function readMessageFile(
  identity: RequestIdentity,
  attachmentId: string,
): Promise<Response> {
  await requireWorkspaceMember(identity);
  const attachment = await getD1()
    .prepare(
      `SELECT
         attachment.id, attachment.object_key, attachment.original_name,
         attachment.media_type, attachment.byte_size, attachment.content_hash
       FROM message_attachments attachment
       INNER JOIN conversation_members member
         ON member.organization_id = attachment.organization_id
        AND member.conversation_id = attachment.conversation_id
        AND member.principal_id = ?
        AND member.status = 'active'
       WHERE attachment.id = ?
         AND attachment.organization_id = ?
         AND (
           attachment.status = 'attached'
           OR (
             attachment.status = 'staged'
             AND attachment.uploader_id = ?
           )
         )
       LIMIT 1`,
    )
    .bind(
      identity.id,
      attachmentId,
      identity.organizationId,
      identity.id,
    )
    .first<FileDownloadRow>();
  if (!attachment) {
    throw new MessageFileRepositoryError("attachment_not_found", 404);
  }
  if (!env.FILES) {
    throw new MessageFileRepositoryError("file_storage_unavailable", 503);
  }
  const object = await env.FILES.get(attachment.object_key);
  if (!object || object.size !== attachment.byte_size) {
    throw new MessageFileRepositoryError("file_storage_unavailable", 503);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.byteLength !== attachment.byte_size ||
    (await sha256Base64Url(bytes)) !== attachment.content_hash
  ) {
    throw new MessageFileRepositoryError("file_storage_unavailable", 503);
  }
  return new Response(bytes, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition(attachment.original_name),
      "content-length": String(attachment.byte_size),
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "application/octet-stream",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-nexus-content-hash": attachment.content_hash,
      "x-nexus-original-media-type": attachment.media_type,
    },
  });
}

export async function stagedMessageAttachments(
  identity: RequestIdentity,
  conversationId: string,
  value: unknown,
): Promise<StagedAttachmentRow[]> {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_MESSAGE_ATTACHMENTS ||
    value.some(
      (candidate) =>
        typeof candidate !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          candidate,
        ),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new MessageFileRepositoryError("invalid_attachment_ids", 400);
  }
  const rows: StagedAttachmentRow[] = [];
  for (const attachmentId of value) {
    const row = await getD1()
      .prepare(
        `SELECT
           id, original_name, media_type, byte_size, content_hash, scan_status
         FROM message_attachments
         WHERE id = ?
           AND organization_id = ?
           AND conversation_id = ?
           AND uploader_id = ?
           AND status = 'staged'
           AND message_id IS NULL
         LIMIT 1`,
      )
      .bind(
        attachmentId,
        identity.organizationId,
        conversationId,
        identity.id,
      )
      .first<StagedAttachmentRow>();
    if (!row) {
      throw new MessageFileRepositoryError(
        "staged_attachment_not_available",
        409,
      );
    }
    rows.push(row);
  }
  return rows;
}

export function attachmentMetadataJson(
  attachments: StagedAttachmentRow[],
): string {
  return attachments.length === 0
    ? "{}"
    : JSON.stringify({ attachmentIds: attachments.map((item) => item.id) });
}

export function attachmentIntegrityEnvelope(
  bodyText: string,
  attachments: StagedAttachmentRow[],
): string {
  if (attachments.length === 0) return bodyText;
  return JSON.stringify({
    bodyText,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      contentHash: attachment.content_hash,
      byteSize: attachment.byte_size,
      originalName: attachment.original_name,
    })),
  });
}

export function attachmentBindingStatements(
  attachments: StagedAttachmentRow[],
  messageId: string,
  now: string,
): D1PreparedStatement[] {
  return attachments.map((attachment) =>
    getD1()
      .prepare(
        `UPDATE message_attachments
         SET message_id = ?, status = 'attached', attached_at = ?
         WHERE id = ? AND status = 'staged' AND message_id IS NULL`,
      )
      .bind(messageId, now, attachment.id),
  );
}

export async function attachmentsForConversationMessages(
  organizationId: string,
  conversationId: string,
): Promise<Map<string, MessageAttachment[]>> {
  const result = await getD1()
    .prepare(
      `SELECT
         id, message_id, original_name, media_type, byte_size,
         content_hash, scan_status
       FROM message_attachments
       WHERE organization_id = ?
         AND conversation_id = ?
         AND status = 'attached'
         AND message_id IS NOT NULL
       ORDER BY created_at, id`,
    )
    .bind(organizationId, conversationId)
    .all<AttachedMessageRow>();
  const byMessage = new Map<string, MessageAttachment[]>();
  for (const row of result.results) {
    const attachments = byMessage.get(row.message_id) ?? [];
    attachments.push({
      id: row.id,
      originalName: row.original_name,
      mediaType: row.media_type,
      byteSize: row.byte_size,
      contentHash: row.content_hash,
      scanStatus: row.scan_status,
      downloadUrl: `/api/files/${row.id}`,
    });
    byMessage.set(row.message_id, attachments);
  }
  return byMessage;
}

async function requireWritableConversationMember(
  identity: RequestIdentity,
  conversationId: string,
): Promise<void> {
  const member = await getD1()
    .prepare(
      `SELECT 1
       FROM conversation_members member
       INNER JOIN conversations conversation
         ON conversation.id = member.conversation_id
        AND conversation.organization_id = member.organization_id
       WHERE member.organization_id = ?
         AND member.conversation_id = ?
         AND member.principal_id = ?
         AND member.status = 'active'
         AND member.role != 'observer'
         AND conversation.status = 'active'
       LIMIT 1`,
    )
    .bind(identity.organizationId, conversationId, identity.id)
    .first();
  if (!member) {
    throw new MessageFileRepositoryError(
      "attachment_conversation_membership_required",
      403,
    );
  }
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    throw new MessageFileRepositoryError("file_content_invalid", 400);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new MessageFileRepositoryError("file_too_large", 413);
    }
    chunks.push(value);
  }
  if (total === 0) {
    throw new MessageFileRepositoryError("file_content_invalid", 400);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseFileName(value: string | null): string {
  if (!value || value.length > 540) {
    throw new MessageFileRepositoryError("file_name_invalid", 400);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).normalize("NFC");
  } catch {
    throw new MessageFileRepositoryError("file_name_invalid", 400);
  }
  if (
    decoded.length < 1 ||
    decoded.length > 180 ||
    decoded !== decoded.trim() ||
    decoded.startsWith(".") ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("..") ||
    [...decoded].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw new MessageFileRepositoryError("file_name_invalid", 400);
  }
  return decoded;
}

function fileExtension(value: string): string {
  const dot = value.lastIndexOf(".");
  return dot < 1 ? "" : value.slice(dot).toLowerCase();
}

function validText(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !text.includes("\0");
  } catch {
    return false;
  }
}

function validJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}

function validJpeg(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0xff, 0xd8, 0xff]) &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

function validGif(bytes: Uint8Array): boolean {
  const signature = new TextDecoder().decode(bytes.slice(0, 6));
  return signature === "GIF87a" || signature === "GIF89a";
}

function validWebp(bytes: Uint8Array): boolean {
  return (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  );
}

function validZip(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    exactArrayBuffer(value),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function contentDisposition(originalName: string): string {
  return `attachment; filename="nexusos-download"; filename*=UTF-8''${encodeURIComponent(
    originalName,
  )}`;
}

type FileDownloadRow = {
  id: string;
  object_key: string;
  original_name: string;
  media_type: string;
  byte_size: number;
  content_hash: string;
};

export type StagedAttachmentRow = {
  id: string;
  original_name: string;
  media_type: string;
  byte_size: number;
  content_hash: string;
  scan_status: MessageAttachment["scanStatus"];
};

type AttachedMessageRow = StagedAttachmentRow & {
  message_id: string;
};
