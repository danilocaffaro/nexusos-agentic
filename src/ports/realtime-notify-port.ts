import type { RealtimeSignal } from "../contracts/realtime";

export interface RealtimeNotifyPort {
  /**
   * Best-effort edge notification. Implementations must absorb validation,
   * transport and delivery failures so an authoritative write can never be
   * reported as failed after it commits.
   */
  publish(signal: RealtimeSignal): Promise<void>;
}
