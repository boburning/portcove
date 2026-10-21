import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

void test("fixed public fuse policy and controlled POSIX transport", (context) => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-B",
      fileURLToPath(
        new URL("../apps/desktop/scripts/native-linux-public-fuse.test.py", import.meta.url),
      ),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  if (process.platform === "linux") assert.doesNotMatch(result.stderr, /skipped=/u);
  context.diagnostic(result.stderr.trim());
});
