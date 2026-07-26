import {
  assertRealtimeSignal,
  RealtimeSignalError,
  toRealtimeWireSignal,
  type RealtimeSignal,
  type RealtimeWireSignal,
} from "../../src/contracts/realtime";
import type { RealtimeNotifyPort } from "../../src/ports/realtime-notify-port";

export type RecordingRealtimeFailure =
  | { code: RealtimeSignalError["code"]; cause: RealtimeSignalError }
  | { code: "realtime_publish_failed"; cause: unknown };

export class RecordingRealtimeNotifyPort implements RealtimeNotifyPort {
  readonly wireSignals: RealtimeWireSignal[] = [];
  readonly failures: RecordingRealtimeFailure[] = [];

  async publish(signal: RealtimeSignal): Promise<void> {
    try {
      assertRealtimeSignal(signal);
      this.wireSignals.push(toRealtimeWireSignal(signal));
    } catch (error) {
      this.failures.push(
        error instanceof RealtimeSignalError
          ? { code: error.code, cause: error }
          : { code: "realtime_publish_failed", cause: error },
      );
    }
  }
}
