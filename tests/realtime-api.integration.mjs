import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.NEXUS_REALTIME_TEST_PORT ?? "3913");
const serverMode = process.env.NEXUS_REALTIME_SERVER_MODE ?? "dev";
const externalBaseUrl = process.env.NEXUS_TEST_BASE_URL;
const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
const testPersistPath = externalBaseUrl
  ? undefined
  : mkdtempSync(join(tmpdir(), "nexusos-realtime-integration-"));
let server;
let serverOutput = "";
const openSockets = [];

const ownerId = "principal-local-owner";
const peerId = "principal-local-test-peer";
const organizationId = "org-local-aurora";
const otherOwnerId = "principal-local-test-other-owner";
const otherOrganizationId = "org-local-test-other";
const roomId = "conversation-local-team-room";
const directId = "conversation-local-owner-atlas";

async function main() {
  try {
    if (!externalBaseUrl) {
    await runCommand("npx", [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "wrangler.local.jsonc",
      "--persist-to",
      testPersistPath,
    ]);
    server = spawn(
      "npx",
      [
        "vinext",
        serverMode,
        "--port",
        String(port),
        "--hostname",
        "127.0.0.1",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NEXUS_ALLOW_TEST_IDENTITIES: "1",
          NEXUS_REALTIME_PUSH: "on",
          NEXUS_PERSIST_STATE_PATH: testPersistPath,
          WRANGLER_LOG_PATH: ".wrangler/wrangler-realtime-integration.log",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", captureServerOutput);
    server.stderr.on("data", captureServerOutput);
    await waitForHealthyServer();
    }

    const ownerSocket = await expectSocketUpgrade(
    `/api/realtime/socket?conversationId=${roomId}`,
    testIdentityHeaders(ownerId, organizationId),
  );
    const peerSocket = await expectSocketUpgrade(
    `/api/realtime/socket?conversationId=${roomId}`,
    testIdentityHeaders(peerId, organizationId),
  );
    openSockets.push(ownerSocket, peerSocket);

    await expectSocketRejection(
    `/api/realtime/socket?conversationId=${directId}`,
    testIdentityHeaders(peerId, organizationId),
      404,
    );
    assert.equal(
      (
        await request(`/api/conversations/${directId}/messages`, {
          headers: testIdentityHeaders(peerId, organizationId),
        })
      ).status,
      404,
    );
    await expectSocketRejection(
    `/api/realtime/socket?conversationId=${roomId}`,
    testIdentityHeaders(otherOwnerId, otherOrganizationId),
      404,
    );
    assert.equal(
      (
        await request(`/api/conversations/${roomId}/messages`, {
          headers: testIdentityHeaders(
            otherOwnerId,
            otherOrganizationId,
          ),
        })
      ).status,
      404,
    );

    const bodyText = `realtime-secret-${crypto.randomUUID()}`;
    const messageResponse = await request(
    `/api/conversations/${roomId}/messages`,
    {
      method: "POST",
      headers: testIdentityHeaders(ownerId, organizationId),
      body: JSON.stringify({ bodyText }),
    },
  );
    assert.equal(messageResponse.status, 201);
    assert.equal((await messageResponse.json()).bodyText, bodyText);

    const expectedFrame = {
      kind: "conversation",
      conversationId: roomId,
    };
    assert.deepEqual(await ownerSocket.nextJson(), expectedFrame);
    assert.deepEqual(await peerSocket.nextJson(), expectedFrame);

    const removePeerResponse = await request(
      `/api/conversations/${roomId}/members/${peerId}`,
      {
        method: "DELETE",
        headers: testIdentityHeaders(ownerId, organizationId),
        body: JSON.stringify({ expectedVersion: 1 }),
      },
    );
    assert.equal(removePeerResponse.status, 200);

    const afterRevocationResponse = await request(
      `/api/conversations/${roomId}/messages`,
      {
        method: "POST",
        headers: testIdentityHeaders(ownerId, organizationId),
        body: JSON.stringify({
          bodyText: `after-revocation-${crypto.randomUUID()}`,
        }),
      },
    );
    assert.equal(afterRevocationResponse.status, 201);
    assert.deepEqual(await ownerSocket.nextJson(), expectedFrame);
    assert.equal(peerSocket.isClosed, false);
    await assert.rejects(
      () => peerSocket.nextJson(400),
      /realtime_frame_timeout/,
      "a revoked member's still-open socket must be excluded by D1 recipients",
    );
    assert.equal(peerSocket.isClosed, false);
    const revokedRead = await request(
      `/api/conversations/${roomId}/messages`,
      { headers: testIdentityHeaders(peerId, organizationId) },
    );
    assert.equal(revokedRead.status, 404);

    process.stdout.write("Realtime API integration passed\n");
  } finally {
    for (const socket of openSockets) {
      socket.close();
    }
    if (server && !server.killed) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => server.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (server.exitCode === null) {
        server.kill("SIGKILL");
      }
    }
    if (testPersistPath) {
      rmSync(testPersistPath, { recursive: true, force: true });
    }
  }
}

async function expectSocketUpgrade(path, headers) {
  const result = await openRealtimeSocket(path, headers);
  assert.equal(
    result.status,
    101,
    `expected WebSocket upgrade for ${path}, got ${result.status}`,
  );
  assert.ok(result.socket);
  return result.socket;
}

async function expectSocketRejection(path, headers, expectedStatus) {
  const result = await openRealtimeSocket(path, headers);
  assert.ok(
    result.status === expectedStatus ||
      (result.status === 0 && result.errorCode === "ECONNRESET"),
    `expected ${expectedStatus} or the documented vinext dev reset, got ${JSON.stringify(result)}`,
  );
  assert.equal(result.socket, undefined);
  if (result.status === 0) {
    const health = await fetch(`${baseUrl}/api/system/health`);
    assert.equal(
      health.status,
      200,
      "a reset counts as a dev-proxy denial only while the Worker stays healthy",
    );
  }
}

function openRealtimeSocket(path, identityHeaders) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const url = new URL(path, baseUrl);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...identityHeaders,
      },
    });
    request.once("upgrade", (response, socket, head) => {
      settled = true;
      resolve({
        status: response.statusCode,
        socket: new RealtimeTestSocket(socket, head),
      });
    });
    request.once("response", (response) => {
      settled = true;
      response.resume();
      response.once("end", () => {
        resolve({ status: response.statusCode });
      });
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (error && typeof error === "object" && "code" in error) {
        resolve({ status: 0, errorCode: error.code });
        return;
      }
      reject(error);
    });
    request.end();
  });
}

class RealtimeTestSocket {
  #buffer = Buffer.alloc(0);
  #messages = [];
  #waiters = [];
  isClosed = false;

  constructor(socket, head) {
    this.socket = socket;
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.on("error", (error) => {
      this.isClosed = true;
      this.#rejectAll(error);
    });
    socket.on("close", () => {
      this.isClosed = true;
      this.#rejectAll(new Error("realtime_socket_closed"));
    });
    if (head.length > 0) this.#receive(head);
  }

  nextJson(timeoutMs = 5_000) {
    return this.#nextText(timeoutMs).then((message) => JSON.parse(message));
  }

  close() {
    this.socket.destroy();
  }

  #nextText(timeoutMs) {
    const queued = this.#messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("realtime_frame_timeout"));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const longLength = this.#buffer.readBigUInt64BE(2);
        if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.#rejectAll(new Error("realtime_frame_too_large"));
          return;
        }
        length = Number(longLength);
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskLength + length) return;
      const mask = masked
        ? this.#buffer.subarray(offset, offset + 4)
        : undefined;
      offset += maskLength;
      const payload = Buffer.from(
        this.#buffer.subarray(offset, offset + length),
      );
      this.#buffer = this.#buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      const opcode = first & 0x0f;
      if (opcode === 0x1) {
        this.#deliver(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.#rejectAll(new Error("realtime_socket_closed"));
      }
    }
  }

  #deliver(message) {
    const waiter = this.#waiters.shift();
    if (!waiter) {
      this.#messages.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  #rejectAll(error) {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

async function waitForHealthyServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(
        `Realtime server exited early (${server?.exitCode}).\n${serverOutput}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`);
      if (response.ok) return;
    } catch {
      // Startup polling is expected to fail until the server listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Realtime server was not healthy within 90 seconds.\n${serverOutput}`,
  );
}

function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function runCommand(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function captureServerOutput(chunk) {
  serverOutput = `${serverOutput}${chunk}`.slice(-16_000);
}

function testIdentityHeaders(principalId, organizationIdValue) {
  return {
    "x-nexus-test-principal": principalId,
    "x-nexus-test-organization": organizationIdValue,
  };
}

await main();
