import {
  CATALOG_DISPLAY_NAME_MAX_CHARS,
  CONNECTION_METHODS,
  CONNECTION_METHOD_TRUST,
  MODEL_ID_PATTERN,
  MODEL_LIFECYCLES,
  PROVIDER_CATALOG_CLAIM,
  PROVIDER_CATALOG_DECLARATION_SPEC_VERSION,
  PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  PROVIDER_CATALOG_MAX_PROVIDERS,
  PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
  PROVIDER_ID_PATTERN,
  type CatalogModelProjection,
  type CatalogProviderProjection,
  type ConnectionMethod,
  type ConnectionMethodProjection,
  type ModelLifecycle,
  type ProviderCatalogEvaluation,
  type ProviderCatalogProjection,
  type ProviderCatalogRejectionReason,
} from "../../contracts/provider-catalog";
import {
  EXECUTION_ENGINE_NAMES,
  type ExecutionEngineName,
} from "../../contracts/execution-engines";
type MutableResult =
  | { status: "accepted"; projection: ProviderCatalogProjection }
  | { status: "rejected"; reason: ProviderCatalogRejectionReason };
const TOP_KEYS = ["specVersion", "providers", "models"] as const;
const PROVIDER_KEYS = ["providerId", "displayName", "methods"] as const;
const METHOD_KEYS = ["method", "cliEngine"] as const;
const MODEL_KEYS = [
  "providerId",
  "modelId",
  "displayName",
  "lifecycle",
] as const;
export function evaluateProviderCatalog(
  input: unknown,
): ProviderCatalogEvaluation {
  try {
    return deepFreeze(evaluate(input));
  } catch {
    return deepFreeze({
      status: "rejected",
      reason: "shape_invalid",
    } as const);
  }
}
export function projectProviderCatalog(
  input: unknown,
): ProviderCatalogProjection | undefined {
  const result = evaluateProviderCatalog(input);
  return result.status === "accepted" ? result.projection : undefined;
}
export function catalogModelKey(
  providerId: string,
  modelId: string,
): string {
  try {
    return `${providerId}/${modelId}`;
  } catch {
    return "/";
  }
}
function evaluate(input: unknown): MutableResult {
  const top = exactRecord(input, TOP_KEYS);
  if (!top) {
    return reject(isPlainRecord(input) ? "shape_invalid" : "input_not_record");
  }
  if (top.specVersion !== PROVIDER_CATALOG_DECLARATION_SPEC_VERSION) {
    return reject("spec_version_mismatch");
  }

  const rawProviders = exactArray(
    top.providers,
    PROVIDER_CATALOG_MAX_PROVIDERS,
  );
  if (!rawProviders) {
    return reject("provider_limit_exceeded");
  }

  const providers: CatalogProviderProjection[] = [];
  const providerIds = new Set<string>();
  for (const rawProvider of rawProviders) {
    const provider = exactRecord(rawProvider, PROVIDER_KEYS);
    if (!provider) return reject("shape_invalid");
    if (
      typeof provider.providerId !== "string" ||
      !PROVIDER_ID_PATTERN.test(provider.providerId)
    ) {
      return reject("provider_id_invalid");
    }
    if (providerIds.has(provider.providerId)) {
      return reject("provider_id_duplicate");
    }
    if (!isDisplayName(provider.displayName)) {
      return reject("display_name_invalid");
    }

    const rawMethods = exactArray(provider.methods, 2);
    if (!rawMethods || rawMethods.length < 1) {
      return reject("method_invalid");
    }
    const methods: ConnectionMethodProjection[] = [];
    const seenMethods = new Set<ConnectionMethod>();
    for (const rawMethod of rawMethods) {
      const methodValue = exactRecord(rawMethod, METHOD_KEYS);
      if (!methodValue) return reject("shape_invalid");
      if (!isConnectionMethod(methodValue.method)) {
        return reject("method_invalid");
      }
      if (seenMethods.has(methodValue.method)) {
        return reject("method_duplicate");
      }
      const cliEngine = methodValue.cliEngine;
      if (
        (methodValue.method === "oauth" && cliEngine !== null) ||
        (methodValue.method === "cli" && !isExecutionEngineName(cliEngine))
      ) {
        return reject("method_engine_mismatch");
      }
      seenMethods.add(methodValue.method);
      methods.push({
        method: methodValue.method,
        trust: CONNECTION_METHOD_TRUST,
        cliEngine:
          methodValue.method === "cli"
            ? (cliEngine as ExecutionEngineName)
            : null,
      });
    }
    providerIds.add(provider.providerId);
    providers.push({
      providerId: provider.providerId,
      displayName: provider.displayName,
      methods: methods.sort((left, right) =>
        compareText(left.method, right.method),
      ),
    });
  }

  const rawModels = exactArray(
    top.models,
    PROVIDER_CATALOG_MAX_PROVIDERS *
      PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  );
  if (!rawModels) {
    return reject("model_limit_exceeded");
  }

  const models: CatalogModelProjection[] = [];
  const modelKeys = new Set<string>();
  const providerModelCounts = new Map<string, number>();
  for (const rawModel of rawModels) {
    const model = exactRecord(rawModel, MODEL_KEYS);
    if (!model) return reject("shape_invalid");
    if (
      typeof model.modelId !== "string" ||
      !MODEL_ID_PATTERN.test(model.modelId)
    ) {
      return reject("model_id_invalid");
    }
    if (!isDisplayName(model.displayName)) {
      return reject("display_name_invalid");
    }
    if (!isModelLifecycle(model.lifecycle)) {
      return reject("lifecycle_invalid");
    }
    if (
      typeof model.providerId !== "string" ||
      !providerIds.has(model.providerId)
    ) {
      return reject("model_provider_unknown");
    }
    const key = catalogModelKey(model.providerId, model.modelId);
    if (modelKeys.has(key)) return reject("model_id_duplicate");
    const count = (providerModelCounts.get(model.providerId) ?? 0) + 1;
    if (count > PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER) {
      return reject("model_limit_exceeded");
    }
    modelKeys.add(key);
    providerModelCounts.set(model.providerId, count);
    models.push({
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      lifecycle: model.lifecycle,
    });
  }

  providers.sort((left, right) =>
    compareText(left.providerId, right.providerId),
  );
  models.sort(
    (left, right) =>
      compareText(left.providerId, right.providerId) ||
      compareText(left.modelId, right.modelId),
  );
  return {
    status: "accepted",
    projection: {
      specVersion: PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
      catalogClaim: PROVIDER_CATALOG_CLAIM,
      providers,
      models,
    },
  };
}
function reject(reason: ProviderCatalogRejectionReason): MutableResult {
  return { status: "rejected", reason };
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys,
): Record<Keys[number], unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== "string") ||
      !expectedKeys.every((key) => keys.includes(key))
    ) {
      return undefined;
    }
    const snapshot = Object.create(null) as Record<Keys[number], unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      snapshot[key as Keys[number]] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
function exactArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      lengthDescriptor.value > maximumLength
    ) {
      return undefined;
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    if (keys.length !== length + 1) return undefined;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return undefined;
  }
}
function isDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= CATALOG_DISPLAY_NAME_MAX_CHARS
  );
}
function isConnectionMethod(value: unknown): value is ConnectionMethod {
  return (
    typeof value === "string" &&
    CONNECTION_METHODS.some((method) => method === value)
  );
}
function isModelLifecycle(value: unknown): value is ModelLifecycle {
  return (
    typeof value === "string" &&
    MODEL_LIFECYCLES.some((lifecycle) => lifecycle === value)
  );
}
function isExecutionEngineName(
  value: unknown,
): value is ExecutionEngineName {
  return (
    typeof value === "string" &&
    EXECUTION_ENGINE_NAMES.some((engine) => engine === value)
  );
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
