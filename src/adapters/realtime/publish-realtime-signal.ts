import { env, waitUntil } from "cloudflare:workers";
import { D1RealtimeRecipientResolver } from "../d1/realtime-recipient-resolver";
import type { RealtimeSignal } from "../../contracts/realtime";
import type { RealtimeNotifyPort } from "../../ports/realtime-notify-port";
import { DurableObjectRealtimeNotifyPort } from "./durable-object-realtime-notify-port";
import { NoopRealtimeNotifyPort } from "./noop-realtime-notify-port";
import { isRealtimePushEnabled } from "../../../worker/realtime-config";

const noopPort = new NoopRealtimeNotifyPort();

export function scheduleRealtimeSignal(signal: RealtimeSignal): void {
  try {
    const publication = selectRealtimeNotifyPort().publish(signal);
    waitUntil(publication.catch(() => undefined));
  } catch (error) {
    try {
      console.warn("[realtime] invalidation scheduling failed", {
        kind: signal.kind,
        cause: error instanceof Error ? error.name : "unknown_failure",
      });
    } catch {
      // Logging must not change an authoritative request outcome.
    }
  }
}

function selectRealtimeNotifyPort(): RealtimeNotifyPort {
  if (!isRealtimePushEnabled(env) || !env.REALTIME_HUB) {
    return noopPort;
  }
  return new DurableObjectRealtimeNotifyPort(
    env.REALTIME_HUB,
    new D1RealtimeRecipientResolver(),
  );
}
