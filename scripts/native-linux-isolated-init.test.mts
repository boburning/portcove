import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

void test("private native init protocol/entry assertions run without namespaces, GUI, credentials or native execution", () => {
  const result = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-B",
      fileURLToPath(new URL("./native-linux-isolated-init.test.py", import.meta.url)),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result, "");
});
