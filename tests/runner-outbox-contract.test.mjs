import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureOutbox,
  persistOperation,
  recoverOutbox,
  transitionOperation,
} from "../runner/durable-outbox.mjs";
import {
  deriveOutboxPathname,
  finalizeOutboxEntry,
  OUTBOX_V1_DIRECTORY,
  OUTBOX_V2_DIRECTORY,
  outboxStorageDirectory,
  parseOutboxEntryText,
} from "../runner/outbox-contract.mjs";

const timestamp = "2026-07-26T12:00:00.000Z";
const operationId = `op_${"1".repeat(32)}`;
const futureOperationId = `op_${"5".repeat(32)}`;
const runId = `run_${"2".repeat(32)}`;
const runnerId = `rnr_${"3".repeat(32)}`;

test("outbox parser accepts frozen v1 and v2 shapes and derives every path", async () => {
  const [legacyText, capabilityText] = await Promise.all([
    readFile(
      new URL("./fixtures/s6-b3/outbox-v1-claim.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "./fixtures/s6-b3/outbox-v2-capability-report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const legacy = parseOutboxEntryText(legacyText);
  const capability = parseOutboxEntryText(capabilityText);
  assert.ok(legacy);
  assert.ok(capability);
  assert.equal(deriveOutboxPathname(legacy), legacy.pathname);
  assert.equal(
    deriveOutboxPathname(capability),
    `/api/runners/${runnerId}/capability-reports`,
  );
});

test("the live reader accepts the exact checked-in v1 fixture", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v1-contract-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await ensureOutbox(stateDir);
  const fixture = await readFile(
    new URL("./fixtures/s6-b3/outbox-v1-claim.json", import.meta.url),
    "utf8",
  );
  await writeFile(
    join(stateDir, OUTBOX_V1_DIRECTORY, `${operationId}.json`),
    fixture,
    { mode: 0o600 },
  );
  const entries = await recoverOutbox(stateDir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operationId, operationId);
});

test("a rolled-back v1 scan preserves v2 and re-upgrade resumes it", async (t) => {
  assert.equal(outboxStorageDirectory(1), OUTBOX_V1_DIRECTORY);
  assert.equal(outboxStorageDirectory(2), OUTBOX_V2_DIRECTORY);
  assert.notEqual(OUTBOX_V1_DIRECTORY, OUTBOX_V2_DIRECTORY);
  assert.equal(OUTBOX_V2_DIRECTORY.startsWith(`${OUTBOX_V1_DIRECTORY}/`), false);

  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-rollback-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await ensureOutbox(stateDir);
  const futureDirectory = join(stateDir, OUTBOX_V2_DIRECTORY);
  const futurePath = join(futureDirectory, `${futureOperationId}.json`);
  const futureBytes = await readFile(
    new URL(
      "./fixtures/s6-b3/outbox-v2-capability-report.json",
      import.meta.url,
    ),
  );
  await writeFile(futurePath, futureBytes, { mode: 0o600 });

  assert.deepEqual(
    (await readdir(join(stateDir, OUTBOX_V1_DIRECTORY))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );
  assert.equal((await stat(futurePath)).isFile(), true);
  const resumed = await recoverOutbox(stateDir);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].operationId, futureOperationId);
  assert.equal(resumed[0].v, 2);
  assert.deepEqual(await readFile(futurePath), futureBytes);
});

test("new writes are v2 while legacy transitions stay in v1", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-dual-write-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await ensureOutbox(stateDir);
  const reportBody = (
    await readFile(
      new URL("./fixtures/s6-b3/capability-report-v1.json", import.meta.url),
    )
  ).subarray(0);
  const reportId = JSON.parse(reportBody.toString("utf8")).reportId;
  const created = await persistOperation(stateDir, {
    operationId: futureOperationId,
    kind: "capability.report",
    runnerId,
    reportId,
    body: reportBody,
  });
  assert.equal(created.v, 2);
  assert.equal(
    (
      await stat(
        join(
          stateDir,
          OUTBOX_V2_DIRECTORY,
          `${futureOperationId}.json`,
        ),
      )
    ).isFile(),
    true,
  );
  await assert.rejects(
    stat(
      join(
        stateDir,
        OUTBOX_V1_DIRECTORY,
        `${futureOperationId}.json`,
      ),
    ),
    { code: "ENOENT" },
  );
  const acked = await transitionOperation(
    stateDir,
    created,
    "acked",
    { status: 201, body: Buffer.from("{}") },
  );
  assert.equal(acked.v, 2);

  const legacyFixture = await readFile(
    new URL("./fixtures/s6-b3/outbox-v1-claim.json", import.meta.url),
    "utf8",
  );
  await writeFile(
    join(stateDir, OUTBOX_V1_DIRECTORY, `${operationId}.json`),
    legacyFixture,
    { mode: 0o600 },
  );
  const mixed = await recoverOutbox(stateDir);
  assert.deepEqual(
    mixed.map((entry) => entry.v).sort(),
    [1, 2],
  );
  const legacy = mixed.find((entry) => entry.v === 1);
  const transitionedLegacy = await transitionOperation(
    stateDir,
    legacy,
    "acked",
    { status: 200, body: Buffer.from("{}") },
  );
  assert.equal(transitionedLegacy.v, 1);
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          stateDir,
          OUTBOX_V1_DIRECTORY,
          `${operationId}.json`,
        ),
        "utf8",
      ),
    ).v,
    1,
  );
});

test("outbox parser rejects injected paths, identity drift and checksum changes", async () => {
  const entry = finalizeOutboxEntry({
    v: 2,
    operationId,
    kind: "run.complete",
    createdAt: timestamp,
    updatedAt: timestamp,
    runId,
    ...body('{"outcome":{"status":"succeeded"}}'),
    status: "pending",
    response: null,
  });
  assert.equal(
    parseOutboxEntryText(
      JSON.stringify({ ...entry, pathname: "https://attacker.invalid" }),
    ),
    undefined,
  );
  assert.equal(
    parseOutboxEntryText(JSON.stringify({ ...entry, runId: `run_${"9".repeat(32)}` })),
    undefined,
  );
  assert.equal(
    parseOutboxEntryText(JSON.stringify({ ...entry, v: 3 })),
    undefined,
  );

  const legacy = parseOutboxEntryText(
    await readFile(
      new URL("./fixtures/s6-b3/outbox-v1-claim.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(legacy);
  assert.equal(
    parseOutboxEntryText(
      JSON.stringify(
        finalizeOutboxEntry({
          ...legacy,
          pathname: `/api/runs/${runId}/complete`,
        }),
      ),
    ),
    undefined,
  );

  const capability = parseOutboxEntryText(
    await readFile(
      new URL(
        "./fixtures/s6-b3/outbox-v2-capability-report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(capability);
  assert.equal(
    parseOutboxEntryText(
      JSON.stringify(
        finalizeOutboxEntry({
          ...capability,
          reportId: `cap_${"9".repeat(32)}`,
        }),
      ),
    ),
    undefined,
  );
});

test("the checked-in v2 outbox body is the valid report fixture exactly", async () => {
  const [report, outbox] = await Promise.all([
    readFile(
      new URL("./fixtures/s6-b3/capability-report-v1.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "./fixtures/s6-b3/outbox-v2-capability-report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const entry = parseOutboxEntryText(outbox);
  assert.ok(entry);
  assert.equal(
    Buffer.from(entry.bodyBase64, "base64url").toString("utf8"),
    report.trimEnd(),
  );
  assert.equal(JSON.parse(report).reportId, entry.reportId);
});

function body(value) {
  const bytes = Buffer.from(value);
  return {
    bodyBase64: bytes.toString("base64url"),
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
