import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  engineReportStatePath,
  EngineReportStateError,
  readEngineReportState,
  shouldSuppressEngineReport,
  writeEngineReportState,
} from "../runner/engine-report-state.mjs";

const fingerprint = "a".repeat(64);
const state = {
  changeFingerprint: fingerprint,
  nextReportBy: "2026-07-27T00:00:00.000Z",
  schemaVersion: 1,
};

test("engine report suppression state is canonical and exact 0600", async (t) => {
  const stateDir = await fixture(t);
  await writeEngineReportState(stateDir, state);
  const path = engineReportStatePath(stateDir);
  assert.equal(
    await readFile(path, "utf8"),
    `{"changeFingerprint":"${fingerprint}","nextReportBy":"2026-07-27T00:00:00.000Z","schemaVersion":1}\n`,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readEngineReportState(stateDir), state);
});

test("suppression is exact fingerprint and strictly before next report time", () => {
  assert.equal(
    shouldSuppressEngineReport(
      state,
      fingerprint,
      new Date("2026-07-26T23:59:59.999Z"),
    ),
    true,
  );
  assert.equal(
    shouldSuppressEngineReport(
      state,
      fingerprint,
      new Date("2026-07-27T00:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    shouldSuppressEngineReport(
      state,
      "b".repeat(64),
      new Date("2026-07-26T12:00:00.000Z"),
    ),
    false,
  );
  assert.equal(
    shouldSuppressEngineReport(undefined, fingerprint, new Date()),
    false,
  );
});

test("missing, corrupt and unsafe suppression state widens reporting", async (t) => {
  const stateDir = await fixture(t);
  const path = engineReportStatePath(stateDir);
  assert.equal(await readEngineReportState(stateDir), undefined);

  for (const text of [
    `{"changeFingerprint":"${fingerprint}","nextReportBy":"bad","schemaVersion":1}\n`,
    `{ "changeFingerprint": "${fingerprint}", "nextReportBy": "2026-07-27T00:00:00.000Z", "schemaVersion": 1 }\n`,
    `\ufeff{"changeFingerprint":"${fingerprint}","nextReportBy":"2026-07-27T00:00:00.000Z","schemaVersion":1}\n`,
    "x".repeat(513),
  ]) {
    await writeFile(path, text, { mode: 0o600 });
    assert.equal(await readEngineReportState(stateDir), undefined);
  }
  await chmod(path, 0o644);
  assert.equal(await readEngineReportState(stateDir), undefined);

  await unlink(path);
  const target = join(stateDir, "suppression-target.json");
  await writeFile(
    target,
    `{"changeFingerprint":"${fingerprint}","nextReportBy":"2026-07-27T00:00:00.000Z","schemaVersion":1}\n`,
    { mode: 0o600 },
  );
  await symlink(target, path);
  assert.equal(await readEngineReportState(stateDir), undefined);
});

test("invalid suppression state is never persisted", async (t) => {
  const stateDir = await fixture(t);
  for (const invalid of [
    { ...state, changeFingerprint: "short" },
    { ...state, nextReportBy: "2026-07-27T00:00:00Z" },
    { ...state, schemaVersion: 2 },
    { ...state, reportId: `egr_${"1".repeat(32)}` },
  ]) {
    await assert.rejects(
      () => writeEngineReportState(stateDir, invalid),
      EngineReportStateError,
    );
  }
  await assert.rejects(stat(engineReportStatePath(stateDir)), {
    code: "ENOENT",
  });
});

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-engine-state-"));
  await chmod(stateDir, 0o700);
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}
