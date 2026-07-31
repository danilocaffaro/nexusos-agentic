declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    FILES: R2Bucket;
    REALTIME_HUB?: DurableObjectNamespace;
    NEXUS_ALLOW_LOCAL_IDENTITY?: string;
    NEXUS_ALLOW_TEST_IDENTITIES?: string;
    NEXUS_MESSAGE_INTEGRITY_KEY?: string;
    NEXUS_PRIVATE_ALPHA_IDENTITY?: string;
    NEXUS_PRIVATE_ALPHA_OWNER_EMAIL?: string;
    NEXUS_PUBLIC_ORIGIN?: string;
    NEXUS_REMOTE_ACCESS?: string;
    NEXUS_REMOTE_BOOTSTRAP_TOKEN_SHA256?: string;
    NEXUS_REMOTE_SESSION_TTL_SECONDS?: string;
    NEXUS_PRESENCE_TTL_SECONDS?: string;
    NEXUS_PROMPT_CIPHER_KEYS?: string;
    NEXUS_REALTIME_PUSH?: string;
    NEXUS_RUNNER_AUDIENCE?: string;
    NEXUS_RUNNER_TEST_TOKEN_TTL_SECONDS?: string;
    NEXUS_RUNNER_TEST_LEASE_TTL_SECONDS?: string;
  }
}
