// UI automation is limited to one exact executable descended from this harness's driver.
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

export function nativeConfirmation({ application, driverPid, output, artifacts }) {
  return async (title, button, expectedText, name) => {
    assert.equal(process.platform, "win32", "Owned native confirmation automation currently requires Windows");
    const result = spawnCommand("pwsh", ["-NoProfile", "-File", fileURLToPath(new URL("./native-confirmation.ps1", import.meta.url)), "-DriverProcessId", String(driverPid), "-ApplicationPath", application, "-Title", title, "-ExpectedText", expectedText, "-Button", button], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observation = JSON.parse(result.stdout);
    const report = path.join(output, `${name}.json`);
    await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" }); artifacts.push(report);
    return observation;
  };
}
