export const REALTIME_HUB_BINDING_NAME = "REALTIME_HUB";
export const REALTIME_HUB_CLASS_NAME = "RealtimeHub";
export const REALTIME_HUB_MIGRATION_TAG = "realtime-hub-v1";

export function isRealtimePushEnabled(environment: {
  NEXUS_REALTIME_PUSH?: string;
  REALTIME_HUB?: unknown;
}): boolean {
  return (
    environment.NEXUS_REALTIME_PUSH === "on" &&
    environment.REALTIME_HUB !== undefined
  );
}

export function isAllowedRealtimeOrigin(
  requestUrl: string,
  origin: string | null,
): boolean {
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

export function realtimeDurableObjectConfig() {
  return {
    durable_objects: {
      bindings: [
        {
          name: REALTIME_HUB_BINDING_NAME,
          class_name: REALTIME_HUB_CLASS_NAME,
        },
      ],
    },
    migrations: [
      {
        tag: REALTIME_HUB_MIGRATION_TAG,
        new_sqlite_classes: [REALTIME_HUB_CLASS_NAME],
      },
    ],
  };
}
