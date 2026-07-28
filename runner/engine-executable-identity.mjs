const DEVICE_PATTERN = /^-?(?:0|[1-9][0-9]{0,39})$/u;
const INODE_PATTERN = /^(?:0|[1-9][0-9]{0,39})$/u;

export function normalizeEngineExecutableFingerprint(value) {
  if (
    !plainRecord(value) ||
    !hasExactKeys(value, [
      "dev",
      "ino",
      "mode",
      "mtimeMs",
      "size",
      "uid",
    ]) ||
    typeof value.dev !== "string" ||
    !DEVICE_PATTERN.test(value.dev) ||
    typeof value.ino !== "string" ||
    !INODE_PATTERN.test(value.ino) ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0 ||
    !Number.isFinite(value.mtimeMs) ||
    value.mtimeMs < 0 ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    size: value.size,
    uid: value.uid,
  });
}

export function sameEngineExecutableFingerprint(left, right) {
  const normalizedLeft = normalizeEngineExecutableFingerprint(left);
  const normalizedRight = normalizeEngineExecutableFingerprint(right);
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      ["dev", "ino", "mode", "mtimeMs", "size", "uid"].every(
        (key) => normalizedLeft[key] === normalizedRight[key],
      )
  );
}

function hasExactKeys(value, expected) {
  try {
    const keys = Reflect.ownKeys(value);
    if (!keys.every((key) => typeof key === "string")) return false;
    const actual = keys.sort();
    const wanted = [...expected].sort();
    return (
      actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]) &&
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
