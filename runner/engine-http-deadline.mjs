import { performance } from "node:perf_hooks";

export const ENGINE_HTTP_IO_TIMEOUT_MS = 10_000;
export const ENGINE_HTTP_TIMEOUT = Symbol("engine_http_timeout");

export class EngineHttpDeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineHttpDeadlineError";
    this.code = "engine_http_deadline_invalid";
  }
}

export function createEngineHttpDeadline(input = {}) {
  const timeoutMs = dataValue(input, "timeoutMs") ??
    ENGINE_HTTP_IO_TIMEOUT_MS;
  const now = dataValue(input, "now") ?? performance.now.bind(performance);
  if (
    !exactRecord(input, [
      ...(dataValue(input, "now") === undefined ? [] : ["now"]),
      ...(dataValue(input, "timeoutMs") === undefined
        ? []
        : ["timeoutMs"]),
    ]) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > ENGINE_HTTP_IO_TIMEOUT_MS ||
    typeof now !== "function"
  ) {
    throw new EngineHttpDeadlineError(
      "Engine HTTP deadline configuration is invalid.",
    );
  }
  let startedAt;
  try {
    startedAt = now();
  } catch {
    throw new EngineHttpDeadlineError(
      "Engine HTTP deadline clock is invalid.",
    );
  }
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new EngineHttpDeadlineError(
      "Engine HTTP deadline clock is invalid.",
    );
  }
  const deadlineAt = startedAt + timeoutMs;
  const controller = new AbortController();
  let closed = false;
  let expired = false;
  let timer;
  let expire;
  const timeout = new Promise((resolve) => {
    expire = () => {
      if (closed || expired) return;
      expired = true;
      try {
        controller.abort();
      } catch {
        // Abort is advisory; timeout classification remains authoritative.
      }
      resolve(ENGINE_HTTP_TIMEOUT);
    };
    timer = setTimeout(expire, timeoutMs);
  });

  const checkpoint = () => {
    if (expired) return false;
    let observed;
    try {
      observed = now();
    } catch {
      expire();
      return false;
    }
    if (!Number.isFinite(observed) || observed >= deadlineAt) {
      expire();
      return false;
    }
    return true;
  };

  return Object.freeze({
    checkpoint,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
    },
    get expired() {
      return expired;
    },
    race(task, onLate) {
      if (typeof task !== "function" || !checkpoint()) {
        return Promise.resolve(ENGINE_HTTP_TIMEOUT);
      }
      let pending;
      try {
        pending = Promise.resolve().then(task);
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (value) => {
          if (expired && typeof onLate === "function") {
            settleBestEffort(() => onLate(value));
          }
        },
        () => undefined,
      );
      return Promise.race([pending, timeout]);
    },
    signal: controller.signal,
  });
}

function settleBestEffort(task) {
  try {
    Promise.resolve().then(task).catch(() => undefined);
  } catch {
    // Hostile late cleanup cannot reopen a closed timeout result.
  }
}

function exactRecord(value, keys) {
  if (!plainRecord(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (!ownKeys.every((key) => typeof key === "string")) return false;
    const actual = ownKeys.sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]) &&
      actual.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && descriptor.enumerable && "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function plainRecord(value) {
  try {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype,
    );
  } catch {
    return false;
  }
}

function dataValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
