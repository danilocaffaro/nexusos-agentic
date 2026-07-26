import {
  MAX_REALTIME_RECIPIENTS,
  toRealtimeDeliveryEnvelope,
  type RealtimeSignal,
} from "../../contracts/realtime";
import type { RealtimeRecipientResolver } from "../d1/realtime-recipient-resolver";
import type { RealtimeNotifyPort } from "../../ports/realtime-notify-port";

export class DurableObjectRealtimeNotifyPort
  implements RealtimeNotifyPort
{
  constructor(
    private readonly hubs: DurableObjectNamespace,
    private readonly recipients: RealtimeRecipientResolver,
    private readonly reportFailure: RealtimePublishFailureReporter =
      defaultFailureReporter,
  ) {}

  async publish(signal: RealtimeSignal): Promise<void> {
    let normalizedSignal: RealtimeSignal;
    try {
      normalizedSignal = toRealtimeDeliveryEnvelope(signal, []).signal;
    } catch (error) {
      this.report({
        kind: signal.kind,
        stage: "signal_validation",
        cause: error,
      });
      return;
    }

    let recipientIds: string[];
    try {
      recipientIds = Array.from(
        new Set(await this.recipients.resolve(normalizedSignal)),
      );
    } catch (error) {
      this.report({
        kind: signal.kind,
        stage: "recipient_resolution",
        cause: error,
      });
      return;
    }
    if (recipientIds.length === 0) {
      this.report({
        kind: signal.kind,
        stage: "no_recipients",
        cause: undefined,
      });
      return;
    }

    for (
      let offset = 0;
      offset < recipientIds.length;
      offset += MAX_REALTIME_RECIPIENTS
    ) {
      try {
        const envelope = toRealtimeDeliveryEnvelope(
          normalizedSignal,
          recipientIds.slice(offset, offset + MAX_REALTIME_RECIPIENTS),
        );
        const hub = this.hubs.getByName(envelope.signal.organizationId);
        const response = await hub.fetch(
          "https://realtime.internal/publish",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(envelope),
          },
        );
        if (!response.ok) {
          throw new Error(`realtime_hub_${response.status}`);
        }
      } catch (error) {
        this.report({
          kind: signal.kind,
          stage: "hub_delivery",
          cause: error,
        });
      }
    }
  }

  private report(failure: RealtimePublishFailure): void {
    try {
      this.reportFailure(failure);
    } catch {
      // Observability is subordinate to the never-reject port contract.
    }
  }
}

export type RealtimePublishFailure = {
  kind: RealtimeSignal["kind"];
  stage:
    | "signal_validation"
    | "recipient_resolution"
    | "no_recipients"
    | "hub_delivery";
  cause: unknown;
};

export type RealtimePublishFailureReporter = (
  failure: RealtimePublishFailure,
) => void;

function defaultFailureReporter(failure: RealtimePublishFailure): void {
  console.warn("[realtime] best-effort invalidation failed", {
    kind: failure.kind,
    stage: failure.stage,
    cause:
      failure.cause instanceof Error
        ? failure.cause.name
        : "unknown_failure",
  });
}
