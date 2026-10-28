import { mkdtemp, writeFile, rm, readFile as readConfiguration } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireResourceCapacity, frontendOutputResource } from "./resource-capacity.mts";
import { acquireRustResources } from "./run-rust-tests.mts";
import { vitePlusNeedsCapacity } from "./run-viteplus.mts";
import test from "node:test";
import assert from "node:assert/strict";
import { runResourceCommand, bootstrapOutputResources } from "./resource-command.mts";
import { nativeBuildCommand } from "./native-build.mts";
import {
  hostTransitionConfiguration,
  replaceResourceConfiguration,
  commitConfigurationTransaction,
  recoveryConfigurationChanges,
} from "./resource-adoption.mts";
import type { TransitionReceipt } from "./resource-adoption.mts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { localNodeResourceProfile, parseNodeTestSuites } from "./node-test-suites.mts";

async function transactionFixture(t: import("node:test").TestContext): Promise<TransitionReceipt> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-transaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const linuxRoot = path.join(directory, "linux"),
    windowsRoot = path.join(directory, "windows");
  await fs.promises.mkdir(linuxRoot);
  await fs.promises.mkdir(windowsRoot);
  const files = [
    path.join(linuxRoot, "config.json"),
    path.join(windowsRoot, "config.json"),
    path.join(linuxRoot, "scratch.json"),
    path.join(windowsRoot, "scratch.json"),
  ];
  const changes = files.map((file, index) => ({
    file,
    previous:
      index < 2
        ? '{"slots":2,"legacyMode":"coordinated"}\n'
        : index === 2
          ? null
          : '{"profile":"previous"}\n',
    next:
      index < 2
        ? '{"slots":1,"legacyMode":"coordinated","nodeSuites":true}\n'
        : '{"profile":"next"}\n',
  }));
  for (const change of changes)
    if (change.previous !== null) await writeFile(change.file, change.previous);
  return {
    format: 1,
    operation: "adopt",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    linuxRoot,
    windowsRoot,
    windowsNativeRoot: "Z:\\fixture\\resources",
    changes,
    bridge: {
      closureSha256: "0".repeat(64),
      executable: "/mnt/z/node.exe",
      script: "Z:\\fixture\\scripts\\bridge.mts",
      distribution: "FixtureLinux",
      user: "developer",
      node: "/usr/bin/node",
      probe: "/fixture/scripts/bridge.mts",
    },
  };
}

async function assertPredecessor(receipt: TransitionReceipt) {
  for (const change of receipt.changes) {
    if (change.previous === null)
      await assert.rejects(readConfiguration(change.file), { code: "ENOENT" });
    else assert.equal(await readConfiguration(change.file, "utf8"), change.previous);
  }
}

void test("host transaction applies, leaves repeated adoption unchanged, and restores settled preimages", async (t) => {
  const receipt = await transactionFixture(t);
  const file = commitConfigurationTransaction(receipt);
  assert.ok(file);
  for (const change of receipt.changes)
    assert.equal(await readConfiguration(change.file, "utf8"), change.next);
  const before = await fs.promises.readdir(path.dirname(file));
  assert.equal(
    commitConfigurationTransaction({
      ...receipt,
      id: randomUUID(),
      changes: receipt.changes.map((change) => ({ ...change, previous: change.next })),
    }),
    null,
  );
  assert.deepEqual(await fs.promises.readdir(path.dirname(file)), before);
  commitConfigurationTransaction({
    ...receipt,
    id: randomUUID(),
    operation: "rollback",
    changes: receipt.changes.map((change) => ({
      file: change.file,
      previous: change.next,
      next: change.previous,
    })),
  });
  await assertPredecessor(receipt);
});

void test("host transaction recovery restores every recognized interrupted phase", async (t) => {
  const pending = '{\n  "slots": 2,\n  "legacyMode": "pending"\n}\n';
  for (const phase of [
    ["pending", "old", "old", "old"],
    ["pending", "pending", "old", "old"],
    ["pending", "pending", "next", "old"],
    ["pending", "pending", "next", "next"],
    ["next", "pending", "next", "next"],
    ["next", "next", "next", "next"],
  ]) {
    const receipt = await transactionFixture(t);
    for (let index = 0; index < phase.length; index++) {
      const change = receipt.changes[index]!;
      const value =
        phase[index] === "pending"
          ? pending
          : phase[index] === "next"
            ? change.next
            : change.previous;
      if (value !== null) await writeFile(change.file, value);
    }
    commitConfigurationTransaction({
      ...receipt,
      id: randomUUID(),
      operation: "recover",
      changes: recoveryConfigurationChanges(receipt.changes),
    });
    await assertPredecessor(receipt);
  }
});

void test("original receipt recovers a recovery interrupted at either pending configuration", async (t) => {
  for (const pendingCount of [1, 2]) {
    const receipt = await transactionFixture(t);
    commitConfigurationTransaction(receipt);
    for (let index = 0; index < pendingCount; index++) {
      const change = receipt.changes[index]!;
      await writeFile(
        change.file,
        JSON.stringify(
          {
            ...JSON.parse(change.next!),
            legacyMode: "pending",
          },
          null,
          2,
        ) + "\n",
      );
    }
    commitConfigurationTransaction({
      ...receipt,
      id: randomUUID(),
      operation: "recover",
      changes: recoveryConfigurationChanges(receipt.changes),
    });
    await assertPredecessor(receipt);
  }
});

void test("host transaction recovery preserves foreign edits without writing any other file", async (t) => {
  const receipt = await transactionFixture(t);
  await writeFile(receipt.changes[3]!.file, "foreign retained bytes");
  const before = receipt.changes.map((change) =>
    fs.existsSync(change.file) ? fs.readFileSync(change.file, "utf8") : null,
  );
  assert.throws(
    () => recoveryConfigurationChanges(receipt.changes),
    /Unknown interrupted-transition preimage/u,
  );
  assert.deepEqual(
    receipt.changes.map((change) =>
      fs.existsSync(change.file) ? fs.readFileSync(change.file, "utf8") : null,
    ),
    before,
  );
});

void test("host transaction restores touched preimages after a real mid-publication failure", async (t) => {
  const receipt = await transactionFixture(t),
    original = fs.renameSync;
  let injected = false;
  const replacement: typeof fs.renameSync = (from, to) => {
    if (!injected && to === receipt.changes[3]!.file) {
      injected = true;
      throw Object.assign(new Error("fixture publication failure"), { code: "EACCES" });
    }
    original(from, to);
  };
  const hook = t.mock.method(fs, "renameSync", replacement);
  syncBuiltinESMExports();
  try {
    assert.throws(() => commitConfigurationTransaction(receipt), /fixture publication failure/u);
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  await assertPredecessor(receipt);
});

void test("host transition preserves predecessor policy and refuses changed configuration preimages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json"),
    previous = '{"slots":2}';
  await writeFile(file, previous);
  replaceResourceConfiguration(file, previous, '{"slots":1}');
  assert.equal(await readConfiguration(file, "utf8"), '{"slots":1}');
  assert.throws(() => replaceResourceConfiguration(file, previous, null), /Configuration changed/u);
  assert.equal(await readConfiguration(file, "utf8"), '{"slots":1}');
  const policy = {
    slots: 2,
    waitMs: 1234,
    legacyRoots: [root],
    legacyMode: "coordinated" as const,
  };
  assert.deepEqual(hostTransitionConfiguration(policy), { ...policy, slots: 1, nodeSuites: true });
  assert.throws(
    () => hostTransitionConfiguration({ ...policy, legacyMode: "pending" }),
    /pending transition/u,
  );
  replaceResourceConfiguration(file, '{"slots":1}', null);
  await assert.rejects(readConfiguration(file), { code: "ENOENT" });
});

void test("local Node resource metadata preserves cheap known selections and covers heavy or unknown work", () => {
  const registry = parseNodeTestSuites(
    JSON.stringify({
      format_version: 1,
      suites: {
        cheap: { arguments: ["--test"], files: ["scripts/report-summary.test.mts"] },
        heavy: {
          arguments: ["--test"],
          files: ["scripts/resource-capacity.test.mts"],
          localResourceProfile: "analysis",
        },
      },
    }),
  );
  assert.equal(localNodeResourceProfile(["scripts/report-summary.test.mts"], registry), undefined);
  for (const files of [
    [],
    ["scripts/unknown.test.mts"],
    ["scripts/resource-capacity.test.mts"],
    ["scripts/report-summary.test.mts", "scripts/resource-capacity.test.mts"],
  ])
    assert.equal(localNodeResourceProfile(files, registry), "analysis");
});

void test("resource command delegates unchanged payload/cwd and failure to the existing supervisor", async () => {
  const status = await runResourceCommand(
    "browser",
    "owned-executable",
    ["literal argument", "--"],
    {
      cwd: process.cwd(),
      environment: { GITHUB_ACTIONS: "true" },
      executionTimeoutMilliseconds: 1234,
      onExecutionTimeout: () => {},
      output: { stdout: 42, stderr: 43 },
      supervise: async (args, options) => {
        assert.deepEqual(args, ["--guard-command", "owned-executable", "literal argument", "--"]);
        assert.equal(options.cwd, process.cwd());
        assert.equal(options.executionTimeoutMilliseconds, 1234);
        assert.equal(typeof options.onExecutionTimeout, "function");
        assert.deepEqual(options.output, { stdout: 42, stderr: 43 });
        assert.equal(typeof options.acquireLock, "function");
        return 23;
      },
    },
  );
  assert.equal(status, 23);
});

void test("resource queue deadline rejects exhausted admission before invoking any supervisor", async () => {
  let effects = 0;
  for (const queueDeadline of [performance.now() - 1, NaN, Infinity])
    await assert.rejects(
      runResourceCommand("analysis", "never", [], {
        queueDeadline,
        supervise: async () => {
          effects++;
          return 0;
        },
      }),
      { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
    );
  assert.equal(effects, 0);
});

void test("original queue deadline bounds an actually occupied isolated capacity domain without launching payload", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "source-queue-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "config.json"),
    JSON.stringify({ slots: 1, legacyMode: "coordinated", waitMs: 60000 }),
  );
  const settings = {
    root: directory,
    environment: {},
    legacyBlocker: async () => null,
    snapshot: () => "fixed",
    pollMs: 10,
    report: () => {},
  };
  const held = await acquireResourceCapacity("analysis", {}, settings);
  let payload = false;
  const started = performance.now();
  try {
    await assert.rejects(
      runResourceCommand("analysis", "never", [], {
        environment: {},
        queueDeadline: started + 500,
        supervise: async (_args, options) => {
          const lease = await options.acquireLock!(
            {},
            { ...settings, waitMs: 60000, waitMilliseconds: 60000 },
          );
          payload = true;
          await lease.release();
          return 0;
        },
      }),
      { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
    );
  } finally {
    await held.release();
  }
  assert.equal(payload, false);
  assert.ok(
    performance.now() - started < 5000,
    "does not inherit the configured 60-second queue wait",
  );
});

void test("native build uses the installed pinned Tauri CLI and literal build arguments", () => {
  const command = nativeBuildCommand(["--no-bundle", "--config", "literal path"], {
    resolve: (name) => {
      assert.equal(name, "@tauri-apps/cli/tauri.js");
      return "fixture/node_modules/@tauri-apps/cli/tauri.js";
    },
  });
  assert.equal(command.executable, process.execPath);
  assert.ok(command.args[0]);
  assert.match(command.args[0], /@tauri-apps[\\/]cli[\\/]tauri\.js$/u);
  assert.deepEqual(command.args.slice(1), ["build", "--no-bundle", "--config", "literal path"]);
  assert.match(command.cwd, /apps[\\/]desktop$/u);
});

void test("full checks, directories and option operands cannot masquerade as cheap explicit-file lint", () => {
  for (const args of [
    ["check"],
    ["check", "."],
    ["check", "scripts/resource-command.mts"],
    ["lint"],
    ["lint", "."],
    ["lint", "--config", "scripts/resource-command.mts"],
    ["lint", "--max-warnings", "0"],
    ["test", "--run"],
  ])
    assert.equal(vitePlusNeedsCapacity(args), true, JSON.stringify(args));
  assert.equal(vitePlusNeedsCapacity(["lint", "scripts/resource-command.mts"]), false);
  assert.equal(
    vitePlusNeedsCapacity(["lint", "--fix", "--", "scripts/resource-command.mts"]),
    false,
  );
  assert.equal(vitePlusNeedsCapacity(["fmt", "--check"]), false);
});

void test("only standalone native help bypasses heavy admission", () => {
  for (const action of ["test", "check", "lint"]) {
    for (const flag of ["--help", "-h"]) {
      assert.equal(vitePlusNeedsCapacity([action, flag]), false);
      assert.equal(vitePlusNeedsCapacity([action, "--", flag]), true);
    }
    assert.equal(vitePlusNeedsCapacity([action, "--help=false"]), true);
    assert.equal(vitePlusNeedsCapacity([action, "--config", "--help"]), true);
    assert.equal(vitePlusNeedsCapacity([action, "--help", "--no-help"]), true);
  }
});

void test("nested Rust cannot bypass output ownership and admitted Cargo jobs remain bounded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-nested-rust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "config.json"), JSON.stringify({ legacyMode: "coordinated" }));
  const options = {
    root,
    environment: {},
    legacyBlocker: async () => null,
    snapshot: () => "fixed",
  };
  const browser = await acquireResourceCapacity("browser", {}, options);
  try {
    await assert.rejects(
      acquireRustResources(
        { workspace: root, cwd: root },
        {
          ...options,
          environment: { ...browser.childEnvironment, CARGO_TARGET_DIR: path.join(root, "target") },
        },
      ),
      /Nested output reservation upgrade refused/u,
    );
  } finally {
    await browser.release();
  }
  const rust = await acquireRustResources(
    { workspace: root, cwd: root },
    {
      ...options,
      environment: { CARGO_TARGET_DIR: path.join(root, "target"), CARGO_BUILD_JOBS: "99" },
    },
  );
  try {
    assert.equal(rust.childEnvironment.CARGO_BUILD_JOBS, "2");
    const nested = await acquireRustResources(
      { workspace: root, cwd: root },
      {
        ...options,
        environment: { ...rust.childEnvironment, CARGO_TARGET_DIR: path.join(root, "target") },
      },
    );
    assert.equal(nested.inherited, true);
  } finally {
    await rust.release();
  }
});

void test("bootstrap protects the actual shared cache while unrelated heavy work remains concurrent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-bootstrap-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "config.json"), JSON.stringify({ legacyMode: "coordinated" }));
  const cache = path.join(root, "shared-cache");
  const firstOutputs = bootstrapOutputResources({
    ...process.env,
    PORTCOVE_SHARED_TOOL_CACHE: cache,
  });
  assert.equal(firstOutputs[1], frontendOutputResource(cache));
  assert.notEqual(
    bootstrapOutputResources({
      ...process.env,
      PORTCOVE_SHARED_TOOL_CACHE: path.join(root, "other-cache"),
    })[1],
    firstOutputs[1],
  );
  const options = { root, environment: {}, legacyBlocker: async () => null };
  const first = await acquireResourceCapacity(
    "rust",
    { workspace: "first setup" },
    { ...options, exclusive: firstOutputs },
  );
  try {
    await assert.rejects(
      acquireResourceCapacity(
        "rust",
        { workspace: "peer setup" },
        {
          ...options,
          waitMs: 0,
          exclusive: [frontendOutputResource(path.join(root, "peer")), firstOutputs[1]],
        },
      ),
      { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
    );
    const independent = await acquireResourceCapacity(
      "analysis",
      { workspace: "independent heavy work" },
      options,
    );
    await independent.release();
  } finally {
    await first.release();
  }
  const peer = await acquireResourceCapacity(
    "rust",
    { workspace: "peer setup" },
    { ...options, exclusive: [frontendOutputResource(path.join(root, "peer")), firstOutputs[1]] },
  );
  await peer.release();
});
