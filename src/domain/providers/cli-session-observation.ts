import {
  CLI_SESSION_NOT_OBSERVED_CLAIM,
  CLI_SESSION_OBSERVATION_CLAIM,
  CLI_SESSION_OBSERVATION_SPEC_VERSION,
  type CliSessionObservationFailureReason,
  type CliSessionObservationResolution,
  type CliSessionRunOptionsSource,
} from "../../contracts/cli-session-observation";
import {
  ENGINE_PROBE_READINESS,
  ENGINE_PROBE_REASONS,
  ENGINE_PROBE_STATUSES,
  EXECUTION_ENGINE_NAMES,
  type EngineProbeReadiness,
  type EngineProbeReason,
  type EngineProbeStatus,
  type ExecutionEngineName,
} from "../../contracts/execution-engines";
import {
  ENGINE_RUN_OPTIONS_MAX_OPTIONS,
  ENGINE_RUN_OPTIONS_SCHEMA_VERSION,
  ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE,
  ENGINE_RUN_OPTION_DISABLED_REASONS,
  type EngineRunOptionDisabledReason,
} from "../../contracts/engine-run-options";
import type {
  ConnectionIntentRejectionReason,
  ConnectionIntentResolution,
} from "../../contracts/connection-intent";
import {
  ENGINE_REPORT_ID_PATTERN,
  isEngineReportVersion,
} from "../runners/engine-report-protocol";
import { RUNNER_TIMESTAMP_PATTERN } from "../runners/runner-protocol";
import { resolveConnectionIntent } from "./connection-intent";

const RUNNER_ID_PATTERN = /^rnr_[0-9a-f]{32}$/u;
const REQUEST_KEYS = ["runnerId", "intent", "declaration"] as const;
const VIEW_KEYS = [
  "schemaVersion",
  "trustDisclosure",
  "truncated",
  "options",
] as const;
const OPTION_KEYS = [
  "evaluatedAt",
  "trust",
  "reportId",
  "receivedAt",
  "freshUntil",
  "engine",
  "status",
  "readiness",
  "reason",
  "version",
  "runnerId",
  "runnerName",
  "runnerState",
  "eligible",
  "disabledReason",
] as const;

type RequestSnapshot = Record<(typeof REQUEST_KEYS)[number], unknown>;
type OptionSnapshot = {
  evaluatedAt: string;
  trust: "hostReported";
  reportId: string | null;
  receivedAt: string | null;
  freshUntil: string | null;
  engine: ExecutionEngineName;
  status: EngineProbeStatus | null;
  readiness: EngineProbeReadiness | null;
  reason: EngineProbeReason | null;
  version: string | null;
  runnerId: string;
  runnerName: string;
  runnerState: "active" | "inactive";
  eligible: boolean;
  disabledReason: EngineRunOptionDisabledReason | null;
};

export async function resolveCliSessionObservation(
  request: unknown,
  source: CliSessionRunOptionsSource,
): Promise<CliSessionObservationResolution> {
  if (!isPlainRecord(request)) return reject("request_invalid");
  const requestSnapshot = exactRecord(request, REQUEST_KEYS);
  if (!requestSnapshot) return reject("request_invalid");
  const { runnerId, intent, declaration } =
    requestSnapshot as RequestSnapshot;
  if (
    typeof runnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(runnerId)
  ) {
    return reject("runner_id_invalid");
  }

  const resolved = resolveConnectionIntent(intent, declaration);
  if (resolved.status === "rejected") {
    return resolved.reason === "catalog_rejected"
      ? rejectCatalogIntent(resolved.reason, resolved.catalogReason)
      : rejectIntent(resolved.reason);
  }
  if (resolved.candidate.method.method !== "cli") {
    return reject("method_not_supported");
  }

  const sourceValue = await source();
  const options = snapshotRunOptionsView(sourceValue);
  if (!options) return reject("engine_inventory_inconsistent");
  const engine = resolved.candidate.method.cliEngine;
  if (!engine) return reject("engine_inventory_inconsistent");
  const matches = options.filter(
    (option) =>
      option.runnerId === runnerId && option.engine === engine,
  );
  if (matches.length === 0) return reject("runner_not_observed");
  if (matches.length !== 1) {
    return reject("engine_inventory_inconsistent");
  }

  const selected = matches[0]!;
  if (!selected.eligible) {
    if (!selected.disabledReason) {
      return reject("engine_inventory_inconsistent");
    }
    return reject(selected.disabledReason);
  }
  if (!isObservedSelection(selected)) {
    return reject("engine_inventory_inconsistent");
  }

  return deepFreeze({
    specVersion: CLI_SESSION_OBSERVATION_SPEC_VERSION,
    status: "observed",
    observationClaim: CLI_SESSION_OBSERVATION_CLAIM,
    candidate: {
      providerId: resolved.candidate.provider.providerId,
      modelId: resolved.candidate.declaredModel?.modelId ?? null,
      cliEngine: engine,
      bindingTrust: resolved.candidate.method.trust,
    },
    observation: {
      runnerId: selected.runnerId,
      reportId: selected.reportId,
      receivedAt: selected.receivedAt,
      freshUntil: selected.freshUntil,
      evaluatedAt: selected.evaluatedAt,
      engineVersion: selected.version,
      trust: selected.trust,
    },
  });
}

function snapshotRunOptionsView(value: unknown): OptionSnapshot[] | undefined {
  if (!isPlainRecord(value)) return undefined;
  const view = exactRecord(value, VIEW_KEYS);
  if (
    !view ||
    view.schemaVersion !== ENGINE_RUN_OPTIONS_SCHEMA_VERSION ||
    view.trustDisclosure !== ENGINE_RUN_OPTIONS_TRUST_DISCLOSURE ||
    typeof view.truncated !== "boolean"
  ) {
    return undefined;
  }
  const items = exactArray(view.options);
  if (!items || items.length > ENGINE_RUN_OPTIONS_MAX_OPTIONS) {
    return undefined;
  }
  const options: OptionSnapshot[] = [];
  const pairs = new Set<string>();
  for (const item of items) {
    const option = snapshotOption(item);
    if (!option) return undefined;
    const pair = `${option.runnerId}\u0000${option.engine}`;
    if (pairs.has(pair)) return undefined;
    pairs.add(pair);
    options.push(option);
  }
  return options;
}

function snapshotOption(value: unknown): OptionSnapshot | undefined {
  if (!isPlainRecord(value)) return undefined;
  const option = exactRecord(value, OPTION_KEYS);
  if (!option) return undefined;
  const {
    evaluatedAt,
    trust,
    reportId,
    receivedAt,
    freshUntil,
    engine,
    status,
    readiness,
    reason,
    version,
    runnerId,
    runnerName,
    runnerState,
    eligible,
    disabledReason,
  } = option;
  if (
    !isCanonicalTimestamp(evaluatedAt) ||
    trust !== "hostReported" ||
    !isNullableReportId(reportId) ||
    !isNullableTimestamp(receivedAt) ||
    !isNullableTimestamp(freshUntil) ||
    !member(EXECUTION_ENGINE_NAMES, engine) ||
    !nullableMember(ENGINE_PROBE_STATUSES, status) ||
    !nullableMember(ENGINE_PROBE_READINESS, readiness) ||
    !nullableMember(ENGINE_PROBE_REASONS, reason) ||
    (version !== null && !isEngineReportVersion(version)) ||
    typeof runnerId !== "string" ||
    !RUNNER_ID_PATTERN.test(runnerId) ||
    typeof runnerName !== "string" ||
    runnerName.length < 1 ||
    runnerName.length > 120 ||
    !member(["active", "inactive"] as const, runnerState) ||
    typeof eligible !== "boolean" ||
    !nullableMember(ENGINE_RUN_OPTION_DISABLED_REASONS, disabledReason)
  ) {
    return undefined;
  }
  const hasReport = reportId !== null;
  if (
    (hasReport && (receivedAt === null || freshUntil === null)) ||
    (!hasReport &&
      (
        receivedAt !== null ||
        freshUntil !== null ||
        status !== null ||
        readiness !== null ||
        reason !== null ||
        version !== null
      ))
  ) {
    return undefined;
  }
  if (
    eligible === (disabledReason !== null) ||
    (runnerState === "inactive" &&
      (eligible || disabledReason !== "runner_inactive")) ||
    (runnerState === "active" && disabledReason === "runner_inactive")
  ) {
    return undefined;
  }
  return {
    evaluatedAt,
    trust,
    reportId,
    receivedAt,
    freshUntil,
    engine,
    status,
    readiness,
    reason,
    version,
    runnerId,
    runnerName,
    runnerState,
    eligible,
    disabledReason,
  };
}

function isObservedSelection(
  option: OptionSnapshot,
): option is OptionSnapshot & {
  reportId: string;
  receivedAt: string;
  freshUntil: string;
  version: string;
} {
  if (
    option.runnerState !== "active" ||
    option.trust !== "hostReported" ||
    option.status !== "available" ||
    option.readiness !== "ready" ||
    option.reason !== "none" ||
    option.disabledReason !== null ||
    option.reportId === null ||
    option.receivedAt === null ||
    option.freshUntil === null ||
    option.version === null
  ) {
    return false;
  }
  const received = Date.parse(option.receivedAt);
  const evaluated = Date.parse(option.evaluatedAt);
  const freshUntil = Date.parse(option.freshUntil);
  return received <= evaluated && evaluated <= freshUntil;
}

function reject(
  reason: Exclude<
    CliSessionObservationFailureReason,
    "connection_intent_rejected"
  >,
): CliSessionObservationResolution {
  return deepFreeze({
    specVersion: CLI_SESSION_OBSERVATION_SPEC_VERSION,
    status: "not_observed",
    observationClaim: CLI_SESSION_NOT_OBSERVED_CLAIM,
    reason,
  });
}

function rejectIntent(
  intentReason: Exclude<
    ConnectionIntentRejectionReason,
    "catalog_rejected"
  >,
): CliSessionObservationResolution {
  return deepFreeze({
    specVersion: CLI_SESSION_OBSERVATION_SPEC_VERSION,
    status: "not_observed",
    observationClaim: CLI_SESSION_NOT_OBSERVED_CLAIM,
    reason: "connection_intent_rejected",
    intentReason,
  });
}

function rejectCatalogIntent(
  intentReason: "catalog_rejected",
  catalogReason: Extract<
    ConnectionIntentResolution,
    {
      status: "rejected";
      reason: "catalog_rejected";
    }
  >["catalogReason"],
): CliSessionObservationResolution {
  return deepFreeze({
    specVersion: CLI_SESSION_OBSERVATION_SPEC_VERSION,
    status: "not_observed",
    observationClaim: CLI_SESSION_NOT_OBSERVED_CLAIM,
    reason: "connection_intent_rejected",
    intentReason,
    catalogReason,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

function exactRecord<const Keys extends readonly string[]>(
  value: object,
  expected: Keys,
): Record<Keys[number], unknown> | undefined {
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string") ||
      !expected.every((key) => keys.includes(key))
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

function exactArray(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const keys = Reflect.ownKeys(value);
    const expected = Array.from(
      { length: value.length },
      (_, index) => String(index),
    );
    if (
      keys.length !== expected.length + 1 ||
      !keys.includes("length") ||
      !expected.every((key) => keys.includes(key))
    ) {
      return undefined;
    }
    const items: unknown[] = [];
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return undefined;
  }
}

function isNullableReportId(value: unknown): value is string | null {
  return value === null ||
    (typeof value === "string" && ENGINE_REPORT_ID_PATTERN.test(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isCanonicalTimestamp(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !RUNNER_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function member<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" &&
    values.some((candidate) => candidate === value);
}

function nullableMember<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] | null {
  return value === null || member(values, value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
