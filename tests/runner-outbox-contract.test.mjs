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
  operationBody,
  persistDeclarationOperation,
  persistOperation,
  pruneOutbox,
  recoverOutbox,
  transitionOperation,
} from "../runner/durable-outbox.mjs";
import {
  deriveOutboxPathname,
  finalizeOutboxEntry,
  OUTBOX_V1_DIRECTORY,
  OUTBOX_V2_DIRECTORY,
  OUTBOX_V3_DIRECTORY,
  outboxStorageDirectory,
  parseOutboxEntryText,
} from "../runner/outbox-contract.mjs";

const timestamp = "2026-07-26T12:00:00.000Z";
const operationId = `op_${"1".repeat(32)}`;
const futureOperationId = `op_${"5".repeat(32)}`;
const declarationOperationId = `op_${"7".repeat(32)}`;
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
  for (const declarationKind of ["toString", "__proto__"]) {
    assert.equal(
      parseOutboxEntryText(
        JSON.stringify({
          ...entry,
          v: 3,
          declarationKind,
        }),
      ),
      undefined,
    );
  }

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

test("prototype declaration kinds reject through the closed outbox error", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v3-prototype-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  for (const declarationKind of ["toString", "__proto__"]) {
    await assert.rejects(
      persistDeclarationOperation(stateDir, {
        operationId: declarationOperationId,
        declarationKind,
        runnerId,
        reportId: `egr_${"0".repeat(32)}`,
        body: Buffer.from("{}"),
      }),
      /Unsupported declaration outbox kind/u,
    );
  }
});

test("legacy outbox clock regression remains accepted and v3 settles monotonically", async (t) => {
  const legacy = parseOutboxEntryText(
    await readFile(
      new URL("./fixtures/s6-b3/outbox-v1-claim.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(legacy);
  const regressed = finalizeOutboxEntry({
    ...legacy,
    updatedAt: "2026-07-25T12:00:00.000Z",
  });
  assert.ok(parseOutboxEntryText(JSON.stringify(regressed)));

  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v3-clock-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const pending = parseOutboxEntryText(
    await readFile(
      new URL(
        "./fixtures/s6-b4/outbox-v3-engine-report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(pending);
  const future = finalizeOutboxEntry({
    ...pending,
    createdAt: "2099-07-26T12:00:00.000Z",
    updatedAt: "2099-07-26T12:00:00.000Z",
  });
  assert.ok(parseOutboxEntryText(JSON.stringify(future)));
  const terminal = await transitionOperation(
    stateDir,
    future,
    "abandoned",
    null,
  );
  assert.equal(terminal.updatedAt, future.createdAt);
  assert.equal(terminal.settledAt, future.createdAt);
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

test("v3 engine declaration fixture is canonical, routed and rollback-safe", async (t) => {
  const [report, fixture] = await Promise.all([
    readFile(
      new URL("./fixtures/s6-b4/engine-report-v1.json", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "./fixtures/s6-b4/outbox-v3-engine-report.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  const entry = parseOutboxEntryText(fixture);
  assert.ok(entry);
  assert.equal(entry.v, 3);
  assert.equal(
    deriveOutboxPathname(entry),
    `/api/runners/${runnerId}/engine-reports`,
  );
  assert.equal(operationBody(entry).toString("utf8"), report.trimEnd());
  assert.equal(outboxStorageDirectory(3), OUTBOX_V3_DIRECTORY);

  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v3-rollback-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await ensureOutbox(stateDir);
  const path = join(
    stateDir,
    OUTBOX_V3_DIRECTORY,
    `${declarationOperationId}.json`,
  );
  await writeFile(path, fixture, { mode: 0o600 });
  assert.deepEqual(
    (await readdir(join(stateDir, OUTBOX_V1_DIRECTORY))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );
  assert.deepEqual(
    (await readdir(join(stateDir, OUTBOX_V2_DIRECTORY))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );
  assert.deepEqual(await readFile(path), Buffer.from(fixture));
  assert.equal(
    (await recoverOutbox(stateDir))[0]?.operationId,
    declarationOperationId,
  );
});

test("checked-in v3 acknowledged tombstone validates without replay bytes", async () => {
  const text = await readFile(
    new URL(
      "./fixtures/s6-b4/outbox-v3-engine-report-acked.json",
      import.meta.url,
    ),
    "utf8",
  );
  const entry = parseOutboxEntryText(text);
  assert.ok(entry);
  assert.equal(entry.status, "acked");
  assert.equal("bodyBase64" in entry, false);
  assert.equal("response" in entry, false);
  assert.throws(() => operationBody(entry), /has no replay body/u);
});

test("v3 transitions scrub request and response bytes into valid tombstones", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v3-scrub-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const reportBody = (
    await readFile(
      new URL("./fixtures/s6-b4/engine-report-v1.json", import.meta.url),
    )
  ).subarray(0, -1);
  const created = await persistDeclarationOperation(stateDir, {
    operationId: declarationOperationId,
    declarationKind: "engine.report",
    runnerId,
    reportId: `egr_${"0".repeat(32)}`,
    body: reportBody,
  });
  assert.equal(created.v, 3);
  const secretResponse = Buffer.from('{"account":"must-not-survive"}');
  const acked = await transitionOperation(
    stateDir,
    created,
    "acked",
    { status: 201, body: secretResponse },
  );
  assert.equal(acked.status, "acked");
  assert.equal("bodyBase64" in acked, false);
  assert.equal("response" in acked, false);
  assert.match(acked.responseSha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => operationBody(acked), /has no replay body/u);
  const stored = await readFile(
    join(
      stateDir,
      OUTBOX_V3_DIRECTORY,
      `${declarationOperationId}.json`,
    ),
    "utf8",
  );
  assert.equal(stored.includes("must-not-survive"), false);
  assert.equal(stored.includes("bodyBase64"), false);
  assert.ok(parseOutboxEntryText(stored));
  const repeated = await transitionOperation(
    stateDir,
    acked,
    "acked",
    { status: 299, body: Buffer.from("must-not-replace") },
  );
  assert.deepEqual(repeated, acked);
  assert.equal(
    await readFile(
      join(
        stateDir,
        OUTBOX_V3_DIRECTORY,
        `${declarationOperationId}.json`,
      ),
      "utf8",
    ),
    stored,
  );

  const second = await persistDeclarationOperation(stateDir, {
    operationId: `op_${"8".repeat(32)}`,
    declarationKind: "engine.report",
    runnerId,
    reportId: `egr_${"0".repeat(32)}`,
    body: reportBody,
  });
  const abandoned = await transitionOperation(
    stateDir,
    second,
    "abandoned",
    null,
  );
  assert.equal(abandoned.responseStatus, null);
  assert.equal(abandoned.responseSha256, null);
  await assert.rejects(
    transitionOperation(
      stateDir,
      await persistDeclarationOperation(stateDir, {
        operationId: `op_${"9".repeat(32)}`,
        declarationKind: "engine.report",
        runnerId,
        reportId: `egr_${"0".repeat(32)}`,
        body: reportBody,
      }),
      "superseded",
      null,
    ),
    /Invalid declaration terminal response/u,
  );
});

test("v3 is quarantined independently and duplicate ids are cross-version", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v3-isolated-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const reportBody = (
    await readFile(
      new URL("./fixtures/s6-b4/engine-report-v1.json", import.meta.url),
    )
  ).subarray(0, -1);
  await persistDeclarationOperation(stateDir, {
    operationId: declarationOperationId,
    declarationKind: "engine.report",
    runnerId,
    reportId: `egr_${"0".repeat(32)}`,
    body: reportBody,
  });
  await assert.rejects(
    persistOperation(stateDir, {
      operationId: declarationOperationId,
      kind: "lease.claim",
      runId,
      body: Buffer.from(
        `{"operationId":"${declarationOperationId}"}`,
      ),
    }),
    /already exists/u,
  );

  const corruptId = `op_${"a".repeat(32)}`;
  await writeFile(
    join(stateDir, OUTBOX_V3_DIRECTORY, `${corruptId}.json`),
    "{}",
    { mode: 0o600 },
  );
  const events = [];
  const entries = await recoverOutbox(stateDir, (event) => events.push(event));
  assert.equal(entries.length, 1);
  assert.equal(events.length, 1);
  assert.equal(
    (await readdir(join(stateDir, OUTBOX_V3_DIRECTORY, "corrupt"))).length,
    1,
  );
  assert.deepEqual(
    (await readdir(join(stateDir, OUTBOX_V1_DIRECTORY))).filter((name) =>
      name.endsWith(".json"),
    ),
    [],
  );
});

test("all scrubbed v3 terminals prune after seven days", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-outbox-v3-prune-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const reportBody = (
    await readFile(
      new URL("./fixtures/s6-b4/engine-report-v1.json", import.meta.url),
    )
  ).subarray(0, -1);
  const created = await persistDeclarationOperation(stateDir, {
    operationId: declarationOperationId,
    declarationKind: "engine.report",
    runnerId,
    reportId: `egr_${"0".repeat(32)}`,
    body: reportBody,
  });
  const terminal = await transitionOperation(
    stateDir,
    created,
    "abandoned",
    null,
  );
  assert.equal(
    await pruneOutbox(
      stateDir,
      Date.parse(terminal.updatedAt) + 7 * 24 * 60 * 60 * 1_000,
    ),
    1,
  );
  assert.deepEqual(await recoverOutbox(stateDir), []);
});

function body(value) {
  const bytes = Buffer.from(value);
  return {
    bodyBase64: bytes.toString("base64url"),
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
