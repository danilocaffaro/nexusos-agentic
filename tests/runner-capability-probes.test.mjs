import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CAPABILITY_ORDER,
  collectCapabilityEvidence,
  PROBE_SPECS,
  PROBE_STREAM_MAX_BYTES,
  PROBE_TIMEOUT_MS,
} from "../runner/capability-probes.mjs";

const sourceUrl = new URL(
  "../runner/capability-probes.mjs",
  import.meta.url,
);

test("probe specifications are frozen, fixed and shell-free", async () => {
  assert.deepEqual(
    PROBE_SPECS.map((spec) => spec.capability),
    CAPABILITY_ORDER,
  );
  assert.equal(Object.isFrozen(PROBE_SPECS), true);
  for (const spec of PROBE_SPECS) {
    assert.equal(Object.isFrozen(spec), true);
    for (const candidate of spec.candidates ?? []) {
      assert.match(candidate, /^\/(?:usr|opt)\//u);
      assert.equal(candidate.includes(".."), false);
    }
    for (const argument of spec.argv ?? []) {
      assert.equal(typeof argument, "string");
      assert.equal(argument.includes("${"), false);
    }
  }
  const landlock = PROBE_SPECS.find(
    (spec) => spec.capability === "landlock",
  );
  assert.deepEqual(
    {
      kind: landlock.kind,
      candidates: landlock.candidates,
      argv: landlock.argv,
    },
    { kind: "none", candidates: [], argv: [] },
  );
  assert.equal(PROBE_TIMEOUT_MS, 3_000);
  assert.equal(PROBE_STREAM_MAX_BYTES, 16 * 1_024);

  const source = await readFile(sourceUrl, "utf8");
  assert.equal(source.includes("shell: true"), false);
  assert.match(
    source,
    /import \{ spawn \} from "node:child_process";/u,
  );
  assert.equal(source.includes("import { exec"), false);
  assert.match(source, /env: \{\}/u);
  assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/u);
  assert.match(source, /child\.kill\("SIGKILL"\)/u);
});

test("strict positive probes map to available without coupling landlock", async (t) => {
  const root = await probeRoot(t);
  await Promise.all([
    executable(root, "/usr/bin/bwrap", "bubblewrap 0.11.0"),
    executable(
      root,
      "/usr/local/bin/docker",
      "Docker version 27.5.1, build abcdef1",
    ),
    executable(root, "/usr/local/bin/podman", "podman version 5.4.2"),
    fixedFile(root, "/proc/self/status", "Name:\tnode\nSeccomp:\t2\n"),
    fixedFile(root, "/proc/sys/user/max_user_namespaces", "128000\n"),
    fixedFile(
      root,
      "/proc/sys/kernel/unprivileged_userns_clone",
      "1\n",
    ),
  ]);

  const evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  assert.deepEqual(
    evidence.map((entry) => entry.capability),
    CAPABILITY_ORDER,
  );
  assert.deepEqual(byCapability(evidence, "bubblewrap"), {
    capability: "bubblewrap",
    detection: "binary_version",
    reasonCode: "none",
    status: "available",
    version: "0.11.0",
  });
  assert.deepEqual(byCapability(evidence, "seccomp"), {
    capability: "seccomp",
    detection: "proc_read",
    reasonCode: "none",
    status: "available",
  });
  assert.deepEqual(byCapability(evidence, "user_namespace"), {
    capability: "user_namespace",
    detection: "proc_read",
    reasonCode: "none",
    status: "available",
  });
  assert.deepEqual(byCapability(evidence, "docker"), {
    capability: "docker",
    detection: "binary_version",
    reasonCode: "none",
    status: "available",
    version: "27.5.1",
  });
  assert.deepEqual(byCapability(evidence, "podman"), {
    capability: "podman",
    detection: "binary_version",
    reasonCode: "none",
    status: "available",
    version: "5.4.2",
  });
  assert.deepEqual(byCapability(evidence, "landlock"), {
    capability: "landlock",
    detection: "none",
    reasonCode: "probe_disabled",
    status: "unknown",
  });
});

test("ambiguous versions and proc states fail closed", async (t) => {
  const root = await probeRoot(t);
  await Promise.all([
    executable(
      root,
      "/usr/bin/bwrap",
      "bubblewrap 0.11.0; host=/home/alice",
    ),
    executable(
      root,
      "/usr/local/bin/docker",
      "Docker version 27.5.1; rm -rf /",
    ),
    executable(
      root,
      "/usr/local/bin/podman",
      `podman version ${"1".repeat(100)}`,
    ),
    fixedFile(root, "/proc/self/status", "Name:\tnode\n"),
    fixedFile(root, "/proc/sys/user/max_user_namespaces", "not-a-number\n"),
  ]);
  const evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  for (const capability of ["bubblewrap", "docker", "podman"]) {
    const entry = byCapability(evidence, capability);
    assert.deepEqual(
      {
        status: entry.status,
        reasonCode: entry.reasonCode,
        version: entry.version,
      },
      { status: "unknown", reasonCode: "unknown", version: undefined },
    );
  }
  assert.deepEqual(byCapability(evidence, "seccomp"), {
    capability: "seccomp",
    detection: "proc_read",
    reasonCode: "not_supported",
    status: "unavailable",
  });
  assert.deepEqual(byCapability(evidence, "user_namespace"), {
    capability: "user_namespace",
    detection: "proc_read",
    reasonCode: "unknown",
    status: "unknown",
  });
});

test("the user namespace dual guard rejects either disabled knob", async (t) => {
  const root = await probeRoot(t);
  await Promise.all([
    fixedFile(root, "/proc/self/status", "Seccomp:\t0\n"),
    fixedFile(root, "/proc/sys/user/max_user_namespaces", "128000\n"),
    fixedFile(
      root,
      "/proc/sys/kernel/unprivileged_userns_clone",
      "0\n",
    ),
  ]);
  let evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  assert.equal(
    byCapability(evidence, "user_namespace").status,
    "unavailable",
  );

  await fixedFile(root, "/proc/sys/user/max_user_namespaces", "0\n");
  await rm(
    rooted(root, "/proc/sys/kernel/unprivileged_userns_clone"),
    { force: true },
  );
  evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  assert.equal(
    byCapability(evidence, "user_namespace").status,
    "unavailable",
  );
});

test("unsupported OS mappings never fabricate tool absence", async () => {
  const evidence = await collectCapabilityEvidence({
    platform: "win32",
  });
  for (const capability of [
    "bubblewrap",
    "seccomp",
    "user_namespace",
  ]) {
    assert.deepEqual(
      byCapability(evidence, capability),
      {
        capability,
        detection: "none",
        reasonCode: "not_supported",
        status: "unavailable",
      },
    );
  }
  for (const capability of ["docker", "podman"]) {
    assert.deepEqual(
      byCapability(evidence, capability),
      {
        capability,
        detection: "none",
        reasonCode: "probe_disabled",
        status: "unknown",
      },
    );
  }
});

test("probe timeout and output overflow are bounded and unknown", async (t) => {
  const root = await probeRoot(t);
  const descendantPidPath = join(root, "descendant.pid");
  await Promise.all([
    executableScript(
      root,
      "/usr/bin/bwrap",
      [
        "#!/bin/sh",
        "/bin/sleep 60 &",
        "child=$!",
        `printf '%s\\n' "$child" > '${descendantPidPath}'`,
        "wait",
        "",
      ].join("\n"),
    ),
    executableScript(
      root,
      "/usr/local/bin/docker",
      "#!/bin/sh\nwhile :; do printf '0123456789abcdef'; done\n",
    ),
    executableScript(
      root,
      "/usr/local/bin/podman",
      "#!/bin/sh\nwhile :; do printf 'fedcba9876543210' >&2; done\n",
    ),
    fixedFile(root, "/proc/self/status", "Seccomp:\t2\n"),
    fixedFile(root, "/proc/sys/user/max_user_namespaces", "1\n"),
  ]);
  const startedAt = Date.now();
  const evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= PROBE_TIMEOUT_MS - 250, `elapsed=${elapsed}`);
  assert.ok(elapsed < PROBE_TIMEOUT_MS + 2_000, `elapsed=${elapsed}`);
  for (const capability of ["bubblewrap", "docker", "podman"]) {
    assert.deepEqual(
      {
        status: byCapability(evidence, capability).status,
        reasonCode: byCapability(evidence, capability).reasonCode,
      },
      { status: "unknown", reasonCode: "unknown" },
    );
  }
  const descendantPid = Number(
    (await readFile(descendantPidPath, "utf8")).trim(),
  );
  assert.equal(Number.isSafeInteger(descendantPid), true);
  await assertProcessExited(descendantPid);
});

test("a present non-executable binary is permission denied", async (t) => {
  const root = await probeRoot(t);
  const path = await executable(
    root,
    "/usr/bin/bwrap",
    "bubblewrap 0.11.0",
  );
  await chmod(path, 0o600);
  const evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  assert.deepEqual(byCapability(evidence, "bubblewrap"), {
    capability: "bubblewrap",
    detection: "binary_version",
    reasonCode: "permission_denied",
    status: "unavailable",
  });
});

test("a writable or foreign candidate never becomes available", async (t) => {
  const root = await probeRoot(t);
  const path = await executable(
    root,
    "/usr/bin/bwrap",
    "bubblewrap 0.11.0",
  );
  await chmod(path, 0o722);
  const evidence = await collectCapabilityEvidence({
    platform: "linux",
    testRoot: root,
  });
  assert.deepEqual(byCapability(evidence, "bubblewrap"), {
    capability: "bubblewrap",
    detection: "binary_version",
    reasonCode: "unknown",
    status: "unknown",
  });
});

test("node probe failures and darwin fixed paths fail closed", async (t) => {
  const root = await probeRoot(t);
  const unsupportedNode = await executableScript(
    root,
    "/node-unsupported",
    "#!/bin/sh\nexit 9\n",
  );
  let evidence = await collectCapabilityEvidence({
    execPath: unsupportedNode,
    platform: "linux",
    testRoot: root,
  });
  assert.deepEqual(byCapability(evidence, "node_permission_model"), {
    capability: "node_permission_model",
    detection: "node_flag",
    reasonCode: "not_supported",
    status: "unavailable",
  });

  const deniedNode = await executableScript(
    root,
    "/node-denied",
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(deniedNode, 0o600);
  evidence = await collectCapabilityEvidence({
    execPath: deniedNode,
    platform: "linux",
    testRoot: root,
  });
  assert.deepEqual(byCapability(evidence, "node_permission_model"), {
    capability: "node_permission_model",
    detection: "node_flag",
    reasonCode: "permission_denied",
    status: "unknown",
  });

  await executable(
    root,
    "/opt/homebrew/bin/podman",
    "podman version 5.5.0",
  );
  evidence = await collectCapabilityEvidence({
    platform: "darwin",
    testRoot: root,
  });
  assert.deepEqual(byCapability(evidence, "podman"), {
    capability: "podman",
    detection: "binary_version",
    reasonCode: "none",
    status: "available",
    version: "5.5.0",
  });
});

async function probeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "nexus-probes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(root, path, line) {
  return executableScript(
    root,
    path,
    `#!/bin/sh\nprintf '%s\\n' '${line}'\n`,
  );
}

async function executableScript(root, path, contents) {
  const target = rooted(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { mode: 0o700 });
  return target;
}

async function fixedFile(root, path, contents) {
  const target = rooted(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, { mode: 0o600 });
  return target;
}

function rooted(root, path) {
  return `${root}${path}`;
}

function byCapability(evidence, capability) {
  return evidence.find((entry) => entry.capability === capability);
}

async function assertProcessExited(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`probe descendant ${pid} is still alive`);
}
