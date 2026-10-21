import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  receiveIsolatedRoleKey,
  supplyIsolatedRoleKey,
  isolatedRoleKeyEnvironment,
} from "./release-role-key-channel.mts";

const linux = process.platform === "linux";
void test("catalog secret names are closed and disjoint from all application secret names", () => {
  for (const role of ["definitions", "policy", "snapshot", "timestamp"]) {
    assert.equal(
      isolatedRoleKeyEnvironment(`catalog-${role}`),
      `PORTCOVE_CATALOG_${role.toUpperCase()}_KEY`,
    );
    if (role === "snapshot" || role === "timestamp")
      assert.notEqual(
        isolatedRoleKeyEnvironment(role),
        isolatedRoleKeyEnvironment(`catalog-${role}`),
      );
  }
  for (const role of [
    "catalog-releases",
    "definitions",
    "PORTCOVE_CATALOG_POLICY_KEY",
    "catalog-policy-extra",
  ])
    assert.throws(() => isolatedRoleKeyEnvironment(role));
});
void test(
  "actual catalog socket reads only the appointed key and rejects app cross-purpose before secret access",
  { skip: !linux },
  async (t) => {
    let reads = 0,
      calls = 0;
    const env: NodeJS.ProcessEnv = {
      get PORTCOVE_CATALOG_SNAPSHOT_KEY() {
        reads++;
        return "catalog-disposable";
      },
      get PORTCOVE_TUF_SNAPSHOT_KEY(): string {
        throw new Error("app secret must not be accessed");
      },
    };
    const wrong = await scratch(t),
      refusing = receiveIsolatedRoleKey(wrong, "catalog-snapshot", Date.now() + 10000, async () => {
        calls++;
      }),
      refused = assert.rejects(refusing);
    await socketReady(wrong);
    await assert.rejects(() => supplyIsolatedRoleKey(wrong, "snapshot", env));
    await refused;
    assert.equal(reads, 0);
    assert.equal(calls, 0);
    const directory = await scratch(t),
      worker = receiveIsolatedRoleKey(
        directory,
        "catalog-snapshot",
        Date.now() + 10000,
        async (key, password) => {
          calls++;
          assert.equal(key, "catalog-disposable");
          assert.equal(password, "");
          return "catalog-result";
        },
      );
    await socketReady(directory);
    await supplyIsolatedRoleKey(directory, "catalog-snapshot", env);
    assert.equal(await worker, "catalog-result");
    assert.equal(reads, 1);
    assert.equal(calls, 1);
  },
);
async function socketReady(directory: string) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      const info = await lstat(path.join(directory, "key.sock"));
      if (info.isSocket() && (info.mode & 0o777) === 0o600) return;
    } catch {}
    if (Date.now() >= deadline) throw new Error("fixture socket did not start");
    await delay(5);
  }
}
async function scratch(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "channel");
}
async function raw(directory: string) {
  const socket = net.createConnection({
    path: path.join(directory, "key.sock"),
    allowHalfOpen: true,
  });
  const challenge = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let bytes: Buffer = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("data", (data: Buffer) => {
      try {
        if (bytes.length + data.length > 4096) throw new Error("fixture challenge overflow");
        bytes = Buffer.concat([bytes, data]);
        if (bytes.indexOf(10) < 0) return;
        resolve(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
  return { socket, challenge };
}
void test("role key transport refuses unsupported host without touching a secret", async (t) => {
  if (linux) {
    t.skip("covered by actual Linux channel tests");
    return;
  }
  let reads = 0;
  const env = new Proxy(
    {},
    {
      get() {
        reads++;
        return "never-read";
      },
    },
  );
  await assert.rejects(
    supplyIsolatedRoleKey(path.resolve(os.tmpdir(), "never-created-role"), "payload", env),
  );
  assert.equal(reads, 0);
});
void test(
  "actual one-use Linux channel hands only the selected disposable key to the private callback",
  { skip: !linux },
  async (t) => {
    const directory = await scratch(t);
    let calls = 0,
      reads = 0;
    const worker = receiveIsolatedRoleKey(
      directory,
      "payload",
      Date.now() + 10000,
      async (key, password) => {
        calls++;
        assert.equal(key, "disposable-payload-key");
        assert.equal(password, "fixture");
        return "private-result";
      },
    );
    await socketReady(directory);
    const env: NodeJS.ProcessEnv = {
      get TAURI_SIGNING_PRIVATE_KEY() {
        reads++;
        return "disposable-payload-key";
      },
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "fixture",
    };
    await supplyIsolatedRoleKey(directory, "payload", env);
    assert.equal(await worker, "private-result");
    assert.equal(calls, 1);
    assert.equal(reads, 1);
    await assert.rejects(supplyIsolatedRoleKey(directory, "payload", env));
    assert.equal(reads, 1);
    await assert.rejects(lstat(directory));
  },
);
void test(
  "wrong challenge, cross-role and oversized frames never enter key consumption",
  { skip: !linux },
  async (t) => {
    for (const fault of ["challenge", "role", "oversized"]) {
      const directory = await scratch(t);
      let calls = 0;
      const worker = receiveIsolatedRoleKey(directory, "releases", Date.now() + 10000, async () => {
        calls++;
      });
      const refused = assert.rejects(worker, /handoff refused/u);
      await socketReady(directory);
      const { socket, challenge } = await raw(directory);
      socket.on("error", () => {});
      socket.end(
        fault === "oversized"
          ? Buffer.alloc(128 * 1024 + 1)
          : JSON.stringify({
              ...challenge,
              key: "disposable",
              password: "",
              ...(fault === "challenge" ? { challenge: "0".repeat(64) } : { role: "snapshot" }),
            }),
      );
      await refused;
      socket.destroy();
      assert.equal(calls, 0);
    }
  },
);
void test(
  "disconnected client cannot publish terminal state or remove private staging before worker joins",
  { skip: !linux },
  async (t) => {
    const directory = await scratch(t);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const worker = receiveIsolatedRoleKey(directory, "snapshot", Date.now() + 10000, async () => {
      entered();
      await latch;
      return "joined";
    });
    const terminal = worker.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await socketReady(directory);
    const { socket, challenge } = await raw(directory);
    socket.on("error", () => {});
    socket.end(JSON.stringify({ ...challenge, key: "disposable-snapshot", password: "" }));
    await inside;
    socket.destroy();
    await delay(10);
    assert.equal(settled, false);
    assert.ok((await lstat(directory)).isDirectory());
    release();
    await terminal;
    assert.equal(settled, true);
    await assert.rejects(lstat(directory));
  },
);
void test(
  "a wrong live role challenge cannot cause client secret access",
  { skip: !linux },
  async (t) => {
    const directory = await scratch(t);
    await mkdir(directory, { mode: 0o700 });
    let reads = 0,
      connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.end(
        JSON.stringify({ schema_version: 1, role: "stable", challenge: "a".repeat(64) }) + "\n",
      );
    });
    await new Promise<void>((resolve) => server.listen(path.join(directory, "key.sock"), resolve));
    await chmod(path.join(directory, "key.sock"), 0o600);
    t.after(() => server.close());
    const env: NodeJS.ProcessEnv = {
      get TAURI_SIGNING_PRIVATE_KEY() {
        reads++;
        return "never-read";
      },
    };
    await assert.rejects(supplyIsolatedRoleKey(directory, "payload", env));
    assert.equal(reads, 0);
    assert.equal(connections, 1);
  },
);
