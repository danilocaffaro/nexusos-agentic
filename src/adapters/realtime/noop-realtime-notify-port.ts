import type { RealtimeSignal } from "../../contracts/realtime";
import type { RealtimeNotifyPort } from "../../ports/realtime-notify-port";

export class NoopRealtimeNotifyPort implements RealtimeNotifyPort {
  async publish(signal: RealtimeSignal): Promise<void> {
    void signal;
    // Polling is the complete fallback product. The noop is intentional.
  }
}
