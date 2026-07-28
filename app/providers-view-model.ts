import {
  BUNDLED_PROVIDER_CATALOG_SOURCE,
  BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION,
  PROVIDER_CATALOG_VIEW_SPEC_VERSION,
} from "@/src/contracts/provider-catalog-source";

const PROVIDER_CATALOG_PROJECTION_SPEC_VERSION =
  "nexusos.provider-catalog-projection.v1";
const PROVIDER_CATALOG_CLAIM = "declared_only_no_connectivity";
const CONNECTION_METHOD_TRUST = "declared_unverified";
const PROVIDER_CATALOG_MAX_PROVIDERS = 16;
const PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER = 64;
const CATALOG_DISPLAY_NAME_MAX_CHARS = 64;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9_@][A-Za-z0-9._@:/+-]{0,255}$/u;
const EXECUTION_ENGINE_NAMES = ["claude_code_cli", "codex_cli"] as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const UNSAFE_LABEL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const FAILURE = Symbol("invalid_shape");
const TOP_KEYS = ["specVersion", "sourceRef", "catalog"] as const;
const SOURCE_KEYS = ["specVersion", "source", "declarationSha256"] as const;
const CATALOG_KEYS = ["specVersion", "catalogClaim", "providers", "models"] as const;
const PROVIDER_KEYS = ["providerId", "displayName", "methods"] as const;
const METHOD_KEYS = ["method", "trust", "cliEngine"] as const;
const MODEL_KEYS = ["providerId", "modelId", "displayName", "lifecycle"] as const;
const METHODS = ["oauth", "cli"] as const;
const LIFECYCLES = ["available", "deprecated", "retired", "unknown"] as const;
const POSITIVE_CLAIM =
  /\b(?:conectad\p{L}*|autenticad\p{L}*|usáve\p{L}*|utilizáve\p{L}*|saudáve\p{L}*|quotas?|cotas?|conta\s+d\p{L}*|reauth\p{L}*|válid\p{L}*)\b/giu;
const NEGATED_WINDOW = /\b(?:não|nem|nunca|sem)\b[^.!?]{0,20}$/iu;

type ConnectionMethod = (typeof METHODS)[number];
type ModelLifecycle = (typeof LIFECYCLES)[number];
type ExecutionEngineName = (typeof EXECUTION_ENGINE_NAMES)[number];
export type ProviderRequestLane = "catalog" | "options" | "observe";
export type ProviderCopyLevel = "status" | "detail";

export type ProviderMethodView = Readonly<{
  method: ConnectionMethod;
  trust: typeof CONNECTION_METHOD_TRUST;
  cliEngine: ExecutionEngineName | null;
}>;

export type ProviderModelView = Readonly<{
  modelId: string;
  displayName: string;
  lifecycle: ModelLifecycle;
}>;

export type ProviderView = Readonly<{
  providerId: string;
  displayName: string;
  methods: readonly ProviderMethodView[];
  models: readonly ProviderModelView[];
}>;

export type ProviderCatalogViewModel = Readonly<{
  specVersion: typeof PROVIDER_CATALOG_VIEW_SPEC_VERSION;
  sourceRef: Readonly<{
    specVersion: typeof BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION;
    source: typeof BUNDLED_PROVIDER_CATALOG_SOURCE;
    declarationSha256: string;
  }>;
  catalogClaim: typeof PROVIDER_CATALOG_CLAIM;
  providers: readonly ProviderView[];
}>;

export type ProviderCliCandidate = Readonly<{
  providerId: string;
  displayName: string;
  cliEngine: ExecutionEngineName;
  trust: typeof CONNECTION_METHOD_TRUST;
}>;

export const PROVIDER_CLIENT_WIRE = deepFreeze({
  projectionSpecVersion: PROVIDER_CATALOG_PROJECTION_SPEC_VERSION,
  catalogClaim: PROVIDER_CATALOG_CLAIM,
  methodTrust: CONNECTION_METHOD_TRUST,
  methods: METHODS,
  lifecycles: LIFECYCLES,
  maxProviders: PROVIDER_CATALOG_MAX_PROVIDERS,
  maxModelsPerProvider: PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  displayNameMaxChars: CATALOG_DISPLAY_NAME_MAX_CHARS,
  providerIdPattern: { source: PROVIDER_ID_PATTERN.source, flags: PROVIDER_ID_PATTERN.flags },
  modelIdPattern: { source: MODEL_ID_PATTERN.source, flags: MODEL_ID_PATTERN.flags },
  executionEngines: EXECUTION_ENGINE_NAMES,
} as const);

export const PROVIDER_STATUS_COPY = deepFreeze({
  loading: "CONSULTANDO DECLARAÇÃO",
  authenticationRequired: "AUTENTICAÇÃO NECESSÁRIA",
  membershipRequired: "ACESSO AO WORKSPACE NECESSÁRIO",
  unavailable: "CATÁLOGO INDISPONÍVEL",
  declared: "DECLARADO · NÃO VERIFICADO",
} as const);

export const PROVIDER_DETAIL_COPY = deepFreeze({
  loading: "Nenhum provider ou credencial está sendo acionado.",
  authenticationRequired:
    "Autenticação necessária para consultar o catálogo declarado.",
  membershipRequired: "Seu usuário não possui acesso a este workspace.",
  unavailable: "A declaração bundled não pôde ser consultada.",
  declared:
    "Catálogo declarado no código. Nenhuma conectividade, credencial ou disponibilidade foi verificada.",
} as const);

type Ticket = Readonly<{
  lane: ProviderRequestLane;
  epoch: number;
  signal: AbortSignal;
}>;

export class ProviderRequestCoordinator {
  #epochs = new Map<ProviderRequestLane, number>();
  #active = new Map<
    ProviderRequestLane,
    { epoch: number; controller: AbortController }
  >();

  begin(lane: ProviderRequestLane): Ticket {
    this.abort(lane);
    const epoch = (this.#epochs.get(lane) ?? 0) + 1;
    const controller = new AbortController();
    this.#epochs.set(lane, epoch);
    this.#active.set(lane, { epoch, controller });
    return { lane, epoch, signal: controller.signal };
  }

  isCurrent(lane: ProviderRequestLane, epoch: number): boolean {
    const active = this.#active.get(lane);
    return active?.epoch === epoch && !active.controller.signal.aborted;
  }

  finish(lane: ProviderRequestLane, epoch: number): boolean {
    if (!this.isCurrent(lane, epoch)) return false;
    this.#active.delete(lane);
    return true;
  }

  abort(lane: ProviderRequestLane): void {
    this.#active.get(lane)?.controller.abort();
    this.#active.delete(lane);
  }

  abortAll(): void {
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
  }
}

export function readProviderCatalogView(
  input: unknown,
): ProviderCatalogViewModel | null {
  try {
    return read(input);
  } catch {
    return null;
  }
}

export function cliCandidatesFrom(
  view: ProviderCatalogViewModel,
): readonly ProviderCliCandidate[] {
  return deepFreeze(
    view.providers.flatMap((provider) =>
      provider.methods.flatMap((method) =>
        method.method === "cli" && method.cliEngine
          ? [{
              providerId: provider.providerId,
              displayName: provider.displayName,
              cliEngine: method.cliEngine,
              trust: method.trust,
            }]
          : [],
      ),
    ),
  );
}

export function catalogDigestMatches(
  view: ProviderCatalogViewModel,
  headerValue: string | null,
): boolean {
  return (
    typeof headerValue === "string" &&
    SHA256.test(headerValue) &&
    headerValue === view.sourceRef.declarationSha256
  );
}

export function providerCopyIsTruthful(
  value: string,
  level: ProviderCopyLevel,
): boolean {
  POSITIVE_CLAIM.lastIndex = 0;
  for (let match = POSITIVE_CLAIM.exec(value); match; match = POSITIVE_CLAIM.exec(value)) {
    if (
      level === "status" ||
      !NEGATED_WINDOW.test(value.slice(Math.max(0, match.index - 20), match.index))
    ) {
      POSITIVE_CLAIM.lastIndex = 0;
      return false;
    }
  }
  POSITIVE_CLAIM.lastIndex = 0;
  return true;
}

function read(input: unknown): ProviderCatalogViewModel | null {
  const top = exactRecord(input, TOP_KEYS);
  if (top === FAILURE || top.specVersion !== PROVIDER_CATALOG_VIEW_SPEC_VERSION) {
    return null;
  }
  const source = exactRecord(top.sourceRef, SOURCE_KEYS);
  const catalog = exactRecord(top.catalog, CATALOG_KEYS);
  if (
    source === FAILURE ||
    catalog === FAILURE ||
    source.specVersion !== BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION ||
    source.source !== BUNDLED_PROVIDER_CATALOG_SOURCE ||
    typeof source.declarationSha256 !== "string" ||
    !SHA256.test(source.declarationSha256) ||
    catalog.specVersion !== PROVIDER_CATALOG_PROJECTION_SPEC_VERSION ||
    catalog.catalogClaim !== PROVIDER_CATALOG_CLAIM
  ) return null;

  const rawProviders = exactArray(catalog.providers, PROVIDER_CATALOG_MAX_PROVIDERS);
  const rawModels = exactArray(
    catalog.models,
    PROVIDER_CATALOG_MAX_PROVIDERS * PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER,
  );
  if (rawProviders === FAILURE || rawModels === FAILURE) return null;

  const providers: Array<{
    providerId: string;
    displayName: string;
    methods: ProviderMethodView[];
    models: ProviderModelView[];
  }> = [];
  const byProvider = new Map<string, (typeof providers)[number]>();
  for (const rawProvider of rawProviders) {
    const provider = exactRecord(rawProvider, PROVIDER_KEYS);
    if (
      provider === FAILURE ||
      typeof provider.providerId !== "string" ||
      !PROVIDER_ID_PATTERN.test(provider.providerId) ||
      !isDisplayName(provider.displayName) ||
      byProvider.has(provider.providerId)
    ) return null;
    const rawMethods = exactArray(provider.methods, METHODS.length);
    if (rawMethods === FAILURE || rawMethods.length === 0) return null;
    const methods: ProviderMethodView[] = [];
    const seenMethods = new Set<ConnectionMethod>();
    for (const rawMethod of rawMethods) {
      const method = exactRecord(rawMethod, METHOD_KEYS);
      if (
        method === FAILURE ||
        !isOneOf(method.method, METHODS) ||
        method.trust !== CONNECTION_METHOD_TRUST ||
        seenMethods.has(method.method) ||
        (method.method === "oauth" && method.cliEngine !== null) ||
        (method.method === "cli" && !isOneOf(method.cliEngine, EXECUTION_ENGINE_NAMES))
      ) return null;
      seenMethods.add(method.method);
      methods.push({
        method: method.method,
        trust: CONNECTION_METHOD_TRUST,
        cliEngine: method.cliEngine as ExecutionEngineName | null,
      });
    }
    const parsed = {
      providerId: provider.providerId,
      displayName: provider.displayName,
      methods,
      models: [] as ProviderModelView[],
    };
    providers.push(parsed);
    byProvider.set(parsed.providerId, parsed);
  }

  const modelKeys = new Set<string>();
  for (const rawModel of rawModels) {
    const model = exactRecord(rawModel, MODEL_KEYS);
    if (
      model === FAILURE ||
      typeof model.providerId !== "string" ||
      typeof model.modelId !== "string" ||
      !MODEL_ID_PATTERN.test(model.modelId) ||
      !isDisplayName(model.displayName) ||
      !isOneOf(model.lifecycle, LIFECYCLES)
    ) return null;
    const provider = byProvider.get(model.providerId);
    const key = `${model.providerId.length}:${model.providerId}${model.modelId}`;
    if (
      !provider ||
      modelKeys.has(key) ||
      provider.models.length >= PROVIDER_CATALOG_MAX_MODELS_PER_PROVIDER
    ) return null;
    modelKeys.add(key);
    provider.models.push({
      modelId: model.modelId,
      displayName: model.displayName,
      lifecycle: model.lifecycle,
    });
  }

  return deepFreeze({
    specVersion: PROVIDER_CATALOG_VIEW_SPEC_VERSION,
    sourceRef: {
      specVersion: BUNDLED_PROVIDER_CATALOG_SOURCE_SPEC_VERSION,
      source: BUNDLED_PROVIDER_CATALOG_SOURCE,
      declarationSha256: source.declarationSha256,
    },
    catalogClaim: PROVIDER_CATALOG_CLAIM,
    providers,
  });
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> | typeof FAILURE {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return FAILURE;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return FAILURE;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    !keys.every((key) => ownKeys.includes(key))
  ) return FAILURE;
  const snapshot = Object.create(null) as Record<Keys[number], unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return FAILURE;
    }
    snapshot[key as Keys[number]] = descriptor.value;
  }
  return snapshot;
}

function exactArray(
  value: unknown,
  limit: number,
): readonly unknown[] | typeof FAILURE {
  if (!Array.isArray(value)) return FAILURE;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > limit
  ) return FAILURE;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.length !== length.value + 1) {
    return FAILURE;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return FAILURE;
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function isDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CATALOG_DISPLAY_NAME_MAX_CHARS * 2 &&
    value === value.trim() &&
    [...value].length <= CATALOG_DISPLAY_NAME_MAX_CHARS &&
    !UNSAFE_LABEL.test(value)
  );
}

function isOneOf<const Values extends readonly unknown[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return values.some((candidate) => candidate === value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
