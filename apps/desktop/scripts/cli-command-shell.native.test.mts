import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { shellCommand } from "../src/cli-command.ts";

void test("passes shell-sensitive values as literal arguments to a harmless child process", () => {
  const shell = process.platform === "win32" ? "powershell" : "posix";
  const args = [
    "two words",
    "Bob's library",
    "$(Write-Output injected)",
    "`echo injected`",
    "semi;colon & pipe|",
    "Unicode 日本語 ‘quote’",
    "C:\\folder with space\\",
    "",
    "<source-path>",
  ];
  const command = shellCommand(
    path.toNamespacedPath(process.execPath),
    ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args],
    shell,
  );
  const child =
    shell === "powershell"
      ? spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        })
      : spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim()), args);
});
