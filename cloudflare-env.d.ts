declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    NEXUS_ALLOW_LOCAL_IDENTITY?: string;
    NEXUS_ALLOW_TEST_IDENTITIES?: string;
    NEXUS_MESSAGE_INTEGRITY_KEY?: string;
    NEXUS_PRESENCE_TTL_SECONDS?: string;
  }
}
