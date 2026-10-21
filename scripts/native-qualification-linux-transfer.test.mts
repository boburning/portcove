import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
void test("native guest binary custody transfer preserves refusal/partial effects without invoking WSL or a candidate", () => {
  assert.equal(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      [
        "-I",
        "-S",
        "-B",
        fileURLToPath(new URL("./native-qualification-linux-transfer.test.py", import.meta.url)),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
    "",
  );
});
