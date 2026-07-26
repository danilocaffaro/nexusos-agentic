import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";
import { realtimeDurableObjectConfig } from "./worker/realtime-config";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ command }) => {
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
        NEXUS_REALTIME_PUSH:
          process.env.NEXUS_REALTIME_PUSH ?? "on",
      }
    : {};

  return {
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
