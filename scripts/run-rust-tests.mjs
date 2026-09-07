import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = path.resolve(process.env.RUNNER_TEMP || process.env.PORTCOVE_TEMP_DIR || tmpdir());
const directory = mkdtempSync(path.join(base, "portcove-host-tool-fixture-"));
const relative = path.relative(base, directory);
if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture escaped its temporary root");
const executable = path.join(directory, process.platform === "win32" ? "probe.exe" : "probe");
let retained = false;
try {
  const compiled = spawnSync("rustc", [
    "--crate-name", "portcove_host_tool_fixture",
    path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
    "-o", executable,
  ], { stdio: "inherit", windowsHide: true });
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) throw new Error("Host-tool fixture compilation failed");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--prepare-only") {
    if (!process.env.GITHUB_ENV) throw new Error("--prepare-only requires GITHUB_ENV");
    appendFileSync(process.env.GITHUB_ENV, `PORTCOVE_HOST_TOOL_FIXTURE=${executable}\n`);
    retained = true; // The runner owns cleanup after all test steps finish.
  } else {
    const scheduling = process.platform === "win32" && !process.env.NEXTEST_TEST_THREADS
      && !args.some(arg => /^--test-threads(?:=|$)/.test(arg))
      ? ["--test-threads", "1"] : [];
    const tested = spawnSync("cargo", ["nextest", "run", ...scheduling, ...args], {
      cwd: root, stdio: "inherit", windowsHide: true,
      env: { ...process.env, PORTCOVE_HOST_TOOL_FIXTURE: executable },
    });
    if (tested.error) throw tested.error;
    process.exitCode = tested.status ?? 1;
  }
} finally {
  if (!retained) rmSync(directory, { recursive: true, force: true });
}
