import { vitePlusNeedsCapacity } from "./run-viteplus.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { runResourceCommand } from "./resource-command.mjs";
import { nativeBuildCommand } from "./native-build.mjs";

test("resource command delegates unchanged payload/cwd and failure to the existing supervisor", async () => {
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

test("native build uses the installed pinned Tauri CLI and literal build arguments", () => {
  const command = nativeBuildCommand(["--no-bundle", "--config", "literal path"], {
    resolve: (name) => {
      assert.equal(name, "@tauri-apps/cli/tauri.js");
      return "fixture/node_modules/@tauri-apps/cli/tauri.js";
    },
  });
  assert.equal(command.executable, process.execPath);
  assert.match(command.args[0], /@tauri-apps[\\/]cli[\\/]tauri\.js$/u);
  assert.deepEqual(command.args.slice(1), ["build", "--no-bundle", "--config", "literal path"]);
  assert.match(command.cwd, /apps[\\/]desktop$/u);
});

test("full checks, directories and option operands cannot masquerade as cheap explicit-file lint", () => {
  for (const args of [
    ["check"],
    ["check", "."],
    ["check", "scripts/resource-command.mjs"],
    ["lint"],
    ["lint", "."],
    ["lint", "--config", "scripts/resource-command.mjs"],
    ["lint", "--max-warnings", "0"],
    ["test", "--run"],
  ])
    assert.equal(vitePlusNeedsCapacity(args), true, JSON.stringify(args));
  assert.equal(vitePlusNeedsCapacity(["lint", "scripts/resource-command.mjs"]), false);
  assert.equal(
    vitePlusNeedsCapacity(["lint", "--fix", "--", "scripts/resource-command.mjs"]),
    false,
  );
  assert.equal(vitePlusNeedsCapacity(["fmt", "--check"]), false);
});
