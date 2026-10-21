import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireResourceCapacity, frontendOutputResource } from "./resource-capacity.mts";
import { acquireRustResources } from "./run-rust-tests.mts";
import { vitePlusNeedsCapacity } from "./run-viteplus.mts";
import test from "node:test";
import assert from "node:assert/strict";
import { runResourceCommand, bootstrapOutputResources } from "./resource-command.mts";
import { nativeBuildCommand } from "./native-build.mts";

void test("resource command delegates unchanged payload/cwd and failure to the existing supervisor", async () => {
  const status = await runResourceCommand(
    "browser",
    "owned-executable",
    ["literal argument", "--"],
    {
      cwd: process.cwd(),
      environment: { GITHUB_ACTIONS: "true" },
      supervise: async (args, options) => {
        assert.deepEqual(args, ["--guard-command", "owned-executable", "literal argument", "--"]);
        assert.equal(options.cwd, process.cwd());
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
