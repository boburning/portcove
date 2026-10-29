import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runResourceCommand } from "./resource-command.mts";

assert.equal(process.platform, "linux");
assert.ok(process.argv.includes("--historical-bootstrap-manifest"));
// Always install this finite consumer budget, including for an inherited lease.
// The maintained reaper joins detached driver/application groups before return.
process.exitCode = await runResourceCommand(
  "rust",
  process.execPath,
  [
    fileURLToPath(
      new URL("../apps/desktop/scripts/desktop-appimage-update-test.mts", import.meta.url),
    ),
    ...process.argv.slice(2),
  ],
  { executionTimeoutMilliseconds: 300_000 },
);
