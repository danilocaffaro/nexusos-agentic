/** Cloudflare Worker entry point for the vinext-starter template. */
import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  IdentityRequiredError,
  requireRequestIdentity,
} from "../src/adapters/identity/request-identity";
import { requireRealtimeSocketAccess } from "../src/adapters/d1/realtime-recipient-resolver";
import { WorkspaceRepositoryError } from "../src/adapters/d1/workspace-repository";
import {
  assertRealtimeOpaqueId,
  RealtimeSignalError,
} from "../src/contracts/realtime";
import {
  isAllowedRealtimeOrigin,
  isRealtimePushEnabled,
} from "./realtime-config";

interface Env extends Cloudflare.Env {
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/realtime/socket") {
      return handleRealtimeSocket(request, env);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) =>
          env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body)
            .transform(width > 0 ? { width } : {})
            .output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

async function handleRealtimeSocket(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isRealtimePushEnabled(env) || !env.REALTIME_HUB) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== "GET") {
    return new Response(null, { status: 405 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(null, {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }
  if (
    !isAllowedRealtimeOrigin(
      request.url,
      request.headers.get("origin"),
    )
  ) {
    return new Response(null, { status: 403 });
  }

  try {
    const identity = requireRequestIdentity(request);
    const url = new URL(request.url);
    const conversationId = url.searchParams.has("conversationId")
      ? url.searchParams.get("conversationId")
      : null;
    if (conversationId !== null) {
      assertRealtimeOpaqueId(conversationId);
    }
    await requireRealtimeSocketAccess(identity, conversationId);

    const headers = new Headers({
      Upgrade: "websocket",
      "x-nexus-internal-principal": identity.id,
    });
    if (conversationId) {
      headers.set("x-nexus-internal-conversation", conversationId);
    }
    const hub = env.REALTIME_HUB.getByName(identity.organizationId);
    return hub.fetch(
      new Request("https://realtime.internal/connect", { headers }),
    );
  } catch (error) {
    if (error instanceof IdentityRequiredError) {
      return Response.json(
        { error: "authentication_required" },
        { status: 401 },
      );
    }
    if (error instanceof WorkspaceRepositoryError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof RealtimeSignalError) {
      return Response.json({ error: error.code }, { status: 400 });
    }
    return Response.json(
      { error: "realtime_connection_failed" },
      { status: 500 },
    );
  }
}

export { RealtimeHub } from "./realtime-hub";
export default worker;
