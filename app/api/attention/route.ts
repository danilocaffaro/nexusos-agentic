import {
  countAttentionItems,
  listAttentionItems,
} from "@/src/adapters/d1/attention-repository";
import { workspaceRoute } from "@/src/adapters/http/workspace-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "count") {
    return workspaceRoute(request, (identity) => countAttentionItems(identity));
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;
  return workspaceRoute(request, (identity) =>
    listAttentionItems(identity, cursor),
  );
}
