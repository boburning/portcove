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
        const lease = await options.acquireLock({ command: "fixture" }, {});
        assert.equal(lease.inherited, true);
        assert.equal(lease.queueMs, 0);
        return 23;
      },
    },
  );
  assert.equal(status, 23);
});

test("native build uses the installed pinned Tauri CLI and literal build arguments", () => {
  const command = nativeBuildCommand(["--no-bundle", "--config", "literal path"]);
  assert.equal(command.executable, process.execPath);
  assert.match(command.args[0], /@tauri-apps[\\/]cli[\\/]tauri\.js$/u);
  assert.deepEqual(command.args.slice(1), ["build", "--no-bundle", "--config", "literal path"]);
  assert.match(command.cwd, /apps[\\/]desktop$/u);
});
