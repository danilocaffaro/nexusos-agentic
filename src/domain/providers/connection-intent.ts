import {
  CONNECTION_INTENT_RESOLUTION_CLAIM,
  CONNECTION_INTENT_RESOLUTION_SPEC_VERSION,
  CONNECTION_INTENT_SPEC_VERSION,
  type ConnectionIntentRejectionReason,
  type ConnectionIntentResolution,
} from "../../contracts/connection-intent";
import {
  EXECUTION_ENGINE_NAMES,
  type ExecutionEngineName,
} from "../../contracts/execution-engines";
import {
  CONNECTION_METHODS,
  MODEL_ID_PATTERN,
  PROVIDER_CATALOG_CLAIM,
  PROVIDER_ID_PATTERN,
  type ConnectionMethod,
  type ProviderCatalogRejectionReason,
} from "../../contracts/provider-catalog";
import {
  catalogModelKey,
  evaluateProviderCatalog,
} from "./provider-catalog";

const INTENT_KEYS = [
  "specVersion",
  "providerId",
  "method",
  "cliEngine",
  "modelId",
] as const;

type IntentSnapshot = Record<(typeof INTENT_KEYS)[number], unknown>;
type SimpleRejectionReason = Exclude<
  ConnectionIntentRejectionReason,
  "catalog_rejected"
>;

export function resolveConnectionIntent(
  intent: unknown,
  declaration: unknown,
): ConnectionIntentResolution {
  if (!isPlainIntentRecord(intent)) return reject("intent_not_record");
  const snapshot = exactIntentRecord(intent);
  if (!snapshot) return reject("intent_structure_invalid");
  if (snapshot.specVersion !== CONNECTION_INTENT_SPEC_VERSION) {
    return reject("intent_spec_version_mismatch");
  }

  const { providerId, method, cliEngine, modelId } = snapshot;
  if (
    typeof providerId !== "string" ||
    typeof method !== "string" ||
    (typeof cliEngine !== "string" && cliEngine !== null) ||
    (typeof modelId !== "string" && modelId !== null)
  ) {
    return reject("intent_field_type_invalid");
  }
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    return reject("intent_provider_id_invalid");
  }
  if (!isConnectionMethod(method)) return reject("intent_method_invalid");
  if (
    (method === "oauth" && cliEngine !== null) ||
    (method === "cli" && !isExecutionEngineName(cliEngine))
  ) {
    return reject("intent_method_engine_mismatch");
  }
  if (modelId !== null && !MODEL_ID_PATTERN.test(modelId)) {
    return reject("intent_model_id_invalid");
  }

  const catalog = evaluateProviderCatalog(declaration);
  if (catalog.status === "rejected") {
    return rejectCatalog(catalog.reason);
  }
  const provider = catalog.projection.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!provider) return reject("provider_not_declared");
  const declaredMethod = provider.methods.find(
    (candidate) => candidate.method === method,
  );
  if (!declaredMethod) return reject("method_not_declared");
  if (
    method === "cli" &&
    declaredMethod.cliEngine !== cliEngine
  ) {
    return reject("engine_not_declared");
  }

  let declaredModel = null;
  if (modelId !== null) {
    const key = catalogModelKey(providerId, modelId);
    const model = catalog.projection.models.find(
      (candidate) =>
        catalogModelKey(candidate.providerId, candidate.modelId) === key,
    );
    if (!model) return reject("model_not_declared");
    declaredModel = {
      modelId: model.modelId,
      displayName: model.displayName,
      lifecycle: model.lifecycle,
    };
  }

  return deepFreeze({
    status: "resolved",
    candidate: {
      specVersion: CONNECTION_INTENT_RESOLUTION_SPEC_VERSION,
      resolutionClaim: CONNECTION_INTENT_RESOLUTION_CLAIM,
      catalogClaim: PROVIDER_CATALOG_CLAIM,
      provider: {
        providerId: provider.providerId,
        displayName: provider.displayName,
      },
      method: {
        method: declaredMethod.method,
        trust: declaredMethod.trust,
        cliEngine: declaredMethod.cliEngine,
      },
      declaredModel,
    },
  });
}

function reject(reason: SimpleRejectionReason): ConnectionIntentResolution {
  return deepFreeze({ status: "rejected", reason });
}

function rejectCatalog(
  catalogReason: ProviderCatalogRejectionReason,
): ConnectionIntentResolution {
  return deepFreeze({
    status: "rejected",
    reason: "catalog_rejected",
    catalogReason,
  });
}

function isPlainIntentRecord(
  value: unknown,
): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactIntentRecord(value: object): IntentSnapshot | undefined {
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== INTENT_KEYS.length ||
      keys.some((key) => typeof key !== "string") ||
      !INTENT_KEYS.every((key) => keys.includes(key))
    ) {
      return undefined;
    }
    const snapshot = Object.create(null) as IntentSnapshot;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      snapshot[key as keyof IntentSnapshot] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function isConnectionMethod(value: string): value is ConnectionMethod {
  return CONNECTION_METHODS.some((candidate) => candidate === value);
}

function isExecutionEngineName(
  value: string | null,
): value is ExecutionEngineName {
  return (
    value !== null &&
    EXECUTION_ENGINE_NAMES.some((candidate) => candidate === value)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
