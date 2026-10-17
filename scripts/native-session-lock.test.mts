import { isRecord } from "./runtime-values.mts";
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { acquireNativeSessionLock } from "./native-session-lock.mts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-native-lock-"));
  return { root, lockPath: path.join(root, "native-desktop") };
}

void test("private XDG child preserves both host-wide and legacy native ownership", async () => {
  const { root } = await fixture();
  try {
    const domain = path.join(root, ".portcove", "resources");
    await mkdir(domain, { recursive: true });
    await writeFile(
      path.join(domain, "config.json"),
      JSON.stringify({ legacyMode: "coordinated" }),
    );
    const moduleUrl = new URL("./native-session-lock.mts", import.meta.url).href;
    const namespaceUrl = new URL("./desktop-linux-x11.mts", import.meta.url).href;
    const childCode = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import path from "node:path";
      const { acquireNativeSessionLock, nativeSessionLockPath, legacyNativeSessionLockPath } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(nativeSessionLockPath(), ${JSON.stringify(path.join(domain, "native-desktop"))});
      const records = [nativeSessionLockPath(), legacyNativeSessionLockPath()].map(value => path.join(value, "owner.json"));
      const before = await Promise.all(records.map(value => readFile(value, "utf8")));
      const inherited = await acquireNativeSessionLock();
      assert.equal(inherited.inherited, true);
      assert.equal(inherited.host.inherited, true);
      await inherited.release();
      assert.deepEqual(await Promise.all(records.map(value => readFile(value, "utf8"))), before);
      await assert.rejects(acquireNativeSessionLock({}, { inheritedToken: "wrong-token" }), /does not match/);
    `;
    const ownerCode = `
      import assert from "node:assert/strict";
      import { readFile } from "node:fs/promises";
      import path from "node:path";
      import { spawnSync } from "node:child_process";
      const { acquireNativeSessionLock, nativeSessionLockPath, legacyNativeSessionLockPath } = await import(${JSON.stringify(moduleUrl)});
      const { linuxNamespaceEnvironment } = await import(${JSON.stringify(namespaceUrl)});
      const owner = await acquireNativeSessionLock({ namespaceDelegation: true });
      const records = [nativeSessionLockPath(), legacyNativeSessionLockPath()].map(value => path.join(value, "owner.json"));
      try {
        const before = await Promise.all(records.map(value => readFile(value, "utf8")));
        const result = spawnSync(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(childCode)}], {
          encoding: "utf8", timeout: 15000, windowsHide: true,
          env: { ...linuxNamespaceEnvironment(process.env, owner.owner.token), XDG_CACHE_HOME: ${JSON.stringify(path.join(root, "private-xdg"))} }
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await Promise.all(records.map(value => readFile(value, "utf8"))), before);
      } finally { await owner.release(); }
      for (const record of records) await assert.rejects(readFile(record), { code: "ENOENT" });
    `;
    for (const sharedCache of [path.join(root, "shared-cache"), undefined]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", ownerCode], {
        encoding: "utf8",
        timeout: 25_000,
        windowsHide: true,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          LOCALAPPDATA: path.join(root, "local-appdata"),
          XDG_CACHE_HOME: path.join(root, "outer-xdg"),
          PORTCOVE_SHARED_TOOL_CACHE: sharedCache,
          PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: undefined,
          PORTCOVE_CONTAINER_GUEST: undefined,
          GITHUB_ACTIONS: undefined,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native lock blocks a live owner and reports its identity", async () => {
  const { root, lockPath } = await fixture();
  try {
    const first = await acquireNativeSessionLock(
      { workspace: "one", profile: "smoke" },
      { lockPath, isProcessAlive: () => true },
    );
    await assert.rejects(
      acquireNativeSessionLock(
        { workspace: "two", profile: "restart" },
        { lockPath, isProcessAlive: () => true },
      ),
      /already owned by PID/,
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native lock preserves PID-only legacy ownership until desktop quiescence is established", async () => {
  const { root, lockPath } = await fixture();
  try {
    await mkdir(lockPath);
    const bytes = JSON.stringify({
      format_version: 1,
      token: "stale",
      pid: 999999,
      created_at: "2026-01-01T00:00:00.000Z",
      workspace: "old",
    });
    await writeFile(path.join(lockPath, "owner.json"), bytes);
    await assert.rejects(
      acquireNativeSessionLock({ workspace: "new" }, { lockPath, isProcessAlive: () => false }),
      { code: "PORTCOVE_RESOURCE_RECOVERY_REQUIRED" },
    );
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native inherited token also requires the same process creation identity", async () => {
  const { root, lockPath } = await fixture();
  try {
    const owner = await acquireNativeSessionLock(
      {},
      { lockPath, inspectProcessIdentity: () => "first-creation" },
    );
    await assert.rejects(
      acquireNativeSessionLock(
        {},
        { lockPath, inheritedToken: owner.owner.token, inspectProcessIdentity: () => "reused-pid" },
      ),
      /verified live creation identity/,
    );
    assert.equal(
      record(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")))
        .process_identity,
      "first-creation",
    );
    await owner.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native lock refuses unreadable owner metadata", async () => {
  const { root, lockPath } = await fixture();
  try {
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), "not json");
    await assert.rejects(
      acquireNativeSessionLock({}, { lockPath, isProcessAlive: () => false }),
      /owner is unreadable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("child harness can inherit but cannot forge a runner lock", async () => {
  const { root, lockPath } = await fixture();
  try {
    const runner = await acquireNativeSessionLock({}, { lockPath, isProcessAlive: () => true });
    const inherited = await acquireNativeSessionLock(
      {},
      { lockPath, inheritedToken: runner.owner.token },
    );
    assert.equal(inherited.inherited, true);
    await inherited.release();
    await assert.rejects(
      acquireNativeSessionLock({}, { lockPath, inheritedToken: "wrong" }),
      /does not match/,
    );
    await runner.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native outer admission cannot hold retirement guards while handover is pending", async () => {
  let inspected = false;
  await assert.rejects(
    acquireNativeSessionLock(
      {},
      {
        lockPath: path.join(os.tmpdir(), "must-not-be-created-portcove-handover"),
        environment: {},
        readConfiguration: async () => {
          inspected = true;
          return { legacyMode: "pending" };
        },
      },
    ),
    { code: "PORTCOVE_RESOURCE_HANDOVER_PENDING" },
  );
  assert.equal(inspected, true);
});

void test("private namespace inheritance requires explicit outer delegation and its exact token", async () => {
  const { root, lockPath } = await fixture();
  try {
    const lease = await acquireNativeSessionLock({ namespaceDelegation: true }, { lockPath });
    try {
      const inherited = await acquireNativeSessionLock(
        {},
        {
          lockPath,
          inheritedToken: lease.owner.token,
          environment: { PORTCOVE_CONTAINER_GUEST: "1" },
          inspectProcessIdentity: () => {
            throw new Error("Namespace PID cannot observe outer PID");
          },
        },
      );
      assert.equal(inherited.inherited, true);
      await assert.rejects(
        acquireNativeSessionLock(
          {},
          { lockPath, inheritedToken: "foreign", environment: { PORTCOVE_CONTAINER_GUEST: "1" } },
        ),
        /does not match/u,
      );
    } finally {
      await lease.release();
    }
    const ordinary = await acquireNativeSessionLock({}, { lockPath });
    try {
      await assert.rejects(
        acquireNativeSessionLock(
          {},
          {
            lockPath,
            inheritedToken: ordinary.owner.token,
            environment: { PORTCOVE_CONTAINER_GUEST: "1" },
          },
        ),
        /lacks an explicit outer delegation/u,
      );
    } finally {
      await ordinary.release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
