import vinext from "vinext";
import { readFile } from "node:fs/promises";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";
import { realtimeDurableObjectConfig } from "./worker/realtime-config";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ command }) => {
  const { d1, r2 } = await readOptionalHostingConfig();
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const isLocalServe = command === "serve";
  const localVars = isLocalServe
    ? {
        NEXUS_ALLOW_LOCAL_IDENTITY: "1",
        ...(process.env.NEXUS_ALLOW_TEST_IDENTITIES === "1"
          ? { NEXUS_ALLOW_TEST_IDENTITIES: "1" }
          : {}),
        ...(process.env.NEXUS_PRESENCE_TTL_SECONDS
          ? {
              NEXUS_PRESENCE_TTL_SECONDS:
                process.env.NEXUS_PRESENCE_TTL_SECONDS,
            }
          : {}),
        ...(process.env.NEXUS_PROMPT_CIPHER_KEYS
          ? {
              NEXUS_PROMPT_CIPHER_KEYS:
                process.env.NEXUS_PROMPT_CIPHER_KEYS,
            }
          : {}),
        NEXUS_REALTIME_PUSH:
          process.env.NEXUS_REALTIME_PUSH ?? "on",
        NEXUS_RUNNER_AUDIENCE:
          process.env.NEXUS_RUNNER_AUDIENCE ?? "http://localhost:3001",
        ...(process.env.NEXUS_RUNNER_TEST_TOKEN_TTL_SECONDS
          ? {
              NEXUS_RUNNER_TEST_TOKEN_TTL_SECONDS:
                process.env.NEXUS_RUNNER_TEST_TOKEN_TTL_SECONDS,
            }
          : {}),
        ...(process.env.NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS
          ? {
              NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS:
                process.env.NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS,
            }
          : {}),
      }
    : {};

  return {
    // Worktrees intentionally share the dependency installation. Vite's
    // default cache lives under node_modules, so concurrent dev/integration
    // servers would otherwise overwrite the same optimized dependency files.
    // Keep generated optimizer state in each worktree instead.
    // vite-plugin-commonjs recognizes pre-bundled output only when its path
    // contains node_modules/.vite; preserve that marker in the local cache.
    cacheDir: ".vinext/node_modules/.vite",
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        persistState: {
          path:
            process.env.NEXUS_PERSIST_STATE_PATH ?? ".wrangler/state",
        },
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
          triggers: { crons: ["* * * * *"] },
          ...realtimeDurableObjectConfig(),
          vars: localVars,
          d1_databases: d1
            ? [
                {
                  binding: d1,
                  database_name: "site-creator-d1",
                  database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
                },
              ]
            : [],
          r2_buckets: r2
            ? [
                {
                  binding: r2,
                  bucket_name: "site-creator-r2",
                },
              ]
            : [],
        },
      }),
    ],
  };
});

async function readOptionalHostingConfig(): Promise<{
  d1: string;
  r2: string | null;
}> {
  try {
    const parsed = JSON.parse(
      await readFile(
        new URL("./.openai/hosting.json", import.meta.url),
        "utf8",
      ),
    ) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { d1?: unknown }).d1 !== "string" ||
      (
        (parsed as { r2?: unknown }).r2 !== null &&
        typeof (parsed as { r2?: unknown }).r2 !== "string"
      )
    ) {
      throw new TypeError("Invalid optional Sites hosting metadata.");
    }
    return {
      d1: (parsed as { d1: string }).d1,
      r2: (parsed as { r2: string | null }).r2,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { d1: "DB", r2: null };
  }
}
