type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function normalize(value: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError(`Circular reference at ${path}`);
    }
    ancestors.add(value);
    const normalized = value.map((item, index) =>
      normalize(item, `${path}[${index}]`, ancestors),
    );
    ancestors.delete(value);
    return normalized;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}`);
    }
    if (ancestors.has(value)) {
      throw new TypeError(`Circular reference at ${path}`);
    }
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const normalized = Object.keys(record)
      .sort()
      .reduce<Record<string, JsonValue>>((result, key) => {
        const item = record[key];
        if (item === undefined) {
          throw new TypeError(`Undefined value at ${path}.${key}`);
        }
        result[key] = normalize(item, `${path}.${key}`, ancestors);
        return result;
      }, {});
    ancestors.delete(value);
    return normalized;
  }

  throw new TypeError(`Unsupported value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$", new WeakSet()));
}
