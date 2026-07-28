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
import {
  reconcileDueEngineRunDeadlines,
} from "../src/adapters/d1/deadline-reconciliation-repository";
import {
  reconcileDueEngineRunCreationRetention,
} from "../src/adapters/d1/engine-run-creation-retention-repository";
import {
  reconcileDuePromptRetention,
} from "../src/adapters/d1/prompt-retention-repository";

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

interface ScheduledController {
  cron: string;
  scheduledTime: number;
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
  scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(runScheduledEngineMaintenance(env.DB));
  },
};

async function runScheduledEngineMaintenance(
  d1: D1Database,
): Promise<void> {
  try {
    const result = await reconcileDueEngineRunDeadlines({
      mode: "scheduled",
    });
    if (
      result.expired > 0 ||
      result.failures.length > 0 ||
      result.truncated
    ) {
      console.info("[deadline-reconciler] scheduled pass", {
        expired: result.expired,
        failures: result.failures.length,
        scanned: result.scanned,
        skipped: result.skipped,
        truncated: result.truncated,
      });
    }
  } catch (error) {
    console.error("[deadline-reconciler] scheduled pass failed", {
      cause: error instanceof Error ? error.name : "unknown_failure",
    });
  }

  try {
    const result = await reconcileDuePromptRetention({
      mode: "scheduled",
    });
    if (result.erased > 0 || result.failures.length > 0 || result.truncated) {
      console.info("[prompt-retention] scheduled pass", {
        erased: result.erased,
        failures: result.failures.length,
        scanned: result.scanned,
        skipped: result.skipped,
        truncated: result.truncated,
      });
    }
  } catch (error) {
    console.error("[prompt-retention] scheduled pass failed", {
      cause: error instanceof Error ? error.name : "unknown_failure",
    });
  }

  try {
    const result = await reconcileDueEngineRunCreationRetention(d1, {
      mode: "scheduled",
    });
    if (result.deleted > 0 || result.skipped > 0 || result.truncated) {
      console.info("[engine-creation-retention] scheduled pass", {
        deleted: result.deleted,
        scanned: result.scanned,
        skipped: result.skipped,
        truncated: result.truncated,
      });
    }
  } catch (error) {
    console.error("[engine-creation-retention] scheduled pass failed", {
      cause: error instanceof Error ? error.name : "unknown_failure",
    });
  }
}

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
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }

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
