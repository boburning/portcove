import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { observeStartup } from "../apps/desktop/scripts/desktop-startup-observation.mjs";

test(
  "startup inventory error retains a partial trace and fails the observer",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-observation-"));
    try {
      const fixture = path.join(output, "inventory-failure.ps1");
      const trace = path.join(output, "trace.jsonl");
      await writeFile(
        fixture,
        `param([string]$Observer, [string]$Image, [string]$Trace, [string]$Profile)
$script:calls = 0
function Get-CimInstance {
    $script:calls++
    if ($script:calls -gt 2) { throw 'synthetic inventory unavailable' }
    [pscustomobject]@{ ProcessId=100; ParentProcessId=0; CreationDate=[DateTime]'2026-01-01'; ExecutablePath=$Image; CommandLine='' }
}
& $Observer -DriverProcessId 100 -DriverPath $Image -ProfilePath $Profile -OutputPath $Trace -StopPath (Join-Path $Profile 'stop') -Samples 3
exit $LASTEXITCODE
`,
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-File",
          fixture,
          "-Observer",
          fileURLToPath(
            new URL("../apps/desktop/scripts/native-startup-observation.ps1", import.meta.url),
          ),
          "-Image",
          process.execPath,
          "-Trace",
          trace,
          "-Profile",
          output,
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      const records = (await readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(records.length, 2);
      assert.equal(records[0].driver_identity_present, true);
      assert.match(records[1].inventory_error, /synthetic inventory unavailable/);
      assert.equal(records[1].driver_departed, false);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);

test(
  "startup observer retains only owned descendants and missing endpoint evidence",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-observation-"));
    const driver = spawn(
      process.execPath,
      ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
      { windowsHide: true },
    );
    await once(driver.stdout, "data");
    try {
      const finish = await observeStartup({
        driver,
        driverPath: process.execPath,
        profile: output,
        output,
        attempt: 0,
      });
      const result = await finish();
      assert.equal(result.successful, true);
      const records = (await readFile(result.artifacts[0], "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(records[0].driver_identity_present, true);
      assert.equal(records[0].devtools_active_port_present, false);
      assert.ok(records[0].processes.some((record) => record.pid === driver.pid));
      assert.ok(
        records.every((record) => !record.processes.some((entry) => entry.pid === process.pid)),
      );
      assert.equal(records.at(-1).stop_requested, true);
      assert.equal(driver.exitCode, null, "observer must not terminate the owned driver");
    } finally {
      const exited = once(driver, "exit");
      driver.kill();
      await exited;
      await rm(output, { recursive: true, force: true });
    }
  },
);

test(
  "startup identity mismatch retains error without claiming an empty process inventory",
  {
    skip: process.platform !== "win32",
    timeout: 20_000,
  },
  async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "portcove-startup-observation-"));
    try {
      const finish = await observeStartup({
        driver: { pid: process.pid, exitCode: null, signalCode: null },
        driverPath: process.env.ComSpec,
        profile: output,
        output,
        attempt: 0,
      });
      const result = await finish();
      assert.equal(result.successful, false);
      assert.equal(result.artifacts.length, 1);
      assert.match(await readFile(result.artifacts[0], "utf8"), /identity mismatch/);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);
