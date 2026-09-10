import path from "node:path";
import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";
import { shellCommand } from "../src/cli-command.ts";

it("passes shell-sensitive values as literal arguments to a harmless child process", () => {
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
      ? spawnSync(
          "pwsh",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
          { encoding: "utf8", windowsHide: true, timeout: 10000 },
        )
      : spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual(args);
});
