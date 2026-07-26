declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    NEXUS_ALLOW_LOCAL_IDENTITY?: string;
  }
}
