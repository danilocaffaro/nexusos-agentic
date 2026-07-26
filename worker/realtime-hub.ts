import { DurableObject } from "cloudflare:workers";
import {
  assertRealtimeDeliveryEnvelope,
  assertRealtimeOpaqueId,
  MAX_REALTIME_ENVELOPE_BYTES,
  toRealtimeWireSignal,
} from "../src/contracts/realtime";

const CONNECT_PATH = "/connect";
const PUBLISH_PATH = "/publish";
const PRINCIPAL_HEADER = "x-nexus-internal-principal";
const CONVERSATION_HEADER = "x-nexus-internal-conversation";

type RealtimeSocketAttachment = {
  principalId: string;
  conversationId: string | null;
};

export class RealtimeHub extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === CONNECT_PATH) {
      return request.method === "GET"
        ? this.acceptSocket(request)
        : new Response(null, { status: 405 });
    }
    if (pathname === PUBLISH_PATH) {
      return request.method === "POST"
        ? this.publish(request)
        : new Response(null, { status: 405 });
    }
    return new Response(null, { status: 404 });
  }

  webSocketMessage(ws: WebSocket): void {
    safeClose(ws, 1008, "client_messages_not_allowed");
  }

  webSocketClose(
    ws: WebSocket,
    code: number,
  ): void {
    safeClose(ws, code, "socket_closed");
  }

  webSocketError(ws: WebSocket): void {
    safeClose(ws, 1011, "realtime_socket_error");
  }

  private acceptSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

    const principalId = request.headers.get(PRINCIPAL_HEADER);
    const conversationId = request.headers.get(CONVERSATION_HEADER);
    try {
      assertRealtimeOpaqueId(principalId);
      if (conversationId !== null) {
        assertRealtimeOpaqueId(conversationId);
      }
    } catch {
      return new Response(null, { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: RealtimeSocketAttachment = {
      principalId,
      conversationId,
    };
    server.serializeAttachment(attachment);
    const tags = ["member", `principal:${principalId}`];
    if (conversationId) {
      tags.push(`conversation:${conversationId}`);
    }
    this.ctx.acceptWebSocket(server, tags);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async publish(request: Request): Promise<Response> {
    const body = await request.text();
    if (
      new TextEncoder().encode(body).byteLength >
      MAX_REALTIME_ENVELOPE_BYTES
    ) {
      return new Response(null, { status: 413 });
    }

    let value: unknown;
    try {
      value = JSON.parse(body);
      assertRealtimeDeliveryEnvelope(value);
      assertRealtimeOpaqueId(this.ctx.id.name);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (value.signal.organizationId !== this.ctx.id.name) {
      return new Response(null, { status: 404 });
    }

    const recipients = new Set(value.recipients);
    const frame = JSON.stringify(toRealtimeWireSignal(value.signal));
    let delivered = 0;
    for (const recipientId of recipients) {
      for (const socket of this.ctx.getWebSockets(`principal:${recipientId}`)) {
        const attachment = readAttachment(socket);
        if (!attachment || attachment.principalId !== recipientId) {
          safeClose(socket, 1008, "invalid_socket_attachment");
          continue;
        }
        try {
          socket.send(frame);
          delivered += 1;
        } catch {
          safeClose(socket, 1011, "realtime_delivery_failed");
        }
      }
    }
    return Response.json({ delivered }, { status: 202 });
  }
}

function readAttachment(
  socket: WebSocket,
): RealtimeSocketAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  try {
    assertRealtimeOpaqueId(candidate.principalId);
    if (candidate.conversationId !== null) {
      assertRealtimeOpaqueId(candidate.conversationId);
    }
  } catch {
    return null;
  }
  return {
    principalId: candidate.principalId,
    conversationId: candidate.conversationId,
  };
}

function safeClose(socket: WebSocket, code: number, reason: string): void {
  if (code === 1005 || code === 1006) return;
  try {
    socket.close(code, reason.slice(0, 123));
  } catch {
    // Closing a dead socket is intentionally idempotent.
  }
}
