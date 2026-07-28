import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireOutboxLock,
  withOutboxLockOwnership,
} from "../runner/durable-outbox.mjs";

test("concurrent short borrows are FIFO and never overlap", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-lock-fifo-"));
  t.after(() => import("node:fs/promises").then(({ rm }) =>
    rm(stateDir, { force: true, recursive: true })
  ));
  const release = await acquireOutboxLock(stateDir);
  let enterFirst;
  let leaveFirst;
  let active = 0;
  const order = [];
  const firstEntered = new Promise((resolve) => {
    enterFirst = resolve;
  });
  const firstMayLeave = new Promise((resolve) => {
    leaveFirst = resolve;
  });

  const first = withOutboxLockOwnership(
    stateDir,
    release,
    async () => {
      active += 1;
      assert.equal(active, 1);
      order.push("first-enter");
      enterFirst();
      await firstMayLeave;
      order.push("first-leave");
      active -= 1;
    },
  );
  await firstEntered;
  const second = withOutboxLockOwnership(
    stateDir,
    release,
    async () => {
      active += 1;
      assert.equal(active, 1);
      order.push("second");
      active -= 1;
    },
  );
  await assert.rejects(
    release(),
    (error) => error?.code === "runner_lock_ownership_in_use",
  );
  leaveFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-enter", "first-leave", "second"]);
  await release();
});

test("a borrow cannot recursively borrow its own ownership", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "nexus-lock-reentrant-"));
  t.after(() => import("node:fs/promises").then(({ rm }) =>
    rm(stateDir, { force: true, recursive: true })
  ));
  const release = await acquireOutboxLock(stateDir);
  await withOutboxLockOwnership(stateDir, release, async () => {
    await assert.rejects(
      withOutboxLockOwnership(
        stateDir,
        release,
        () => "unreachable",
      ),
      (error) => error?.code === "runner_lock_ownership_in_use",
    );
  });
  await release();
});
