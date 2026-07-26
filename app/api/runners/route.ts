import { listRunners } from "@/src/adapters/d1/runner-repository";
import { runnerWorkspaceRoute } from "@/src/adapters/http/runner-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runnerWorkspaceRoute(request, (identity) => listRunners(identity));
}
