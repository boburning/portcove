// UI automation is limited to one exact executable descended from this harness's driver.
import assert from "node:assert/strict";
import path from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnCommand } from "../../../scripts/dev-storage.mjs";

async function validatePickerInput({ output, title, button, filePath, directoryPath }) {
  assert.ok(!(filePath && directoryPath), "Choose only one native picker input");
  const pickerPath = filePath ?? directoryPath;
  if (pickerPath) {
    const relative = path.relative(output, pickerPath);
    assert.ok(
      path.isAbsolute(pickerPath) &&
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative),
      "Native picker input must be an owned output fixture",
    );
  }
  if (directoryPath) {
    assert.equal(title, "Choose Portcove library");
    assert.equal(button, "Select Folder");
    assert.ok((await stat(directoryPath)).isDirectory(), "Owned picker fixture is not a directory");
  }
}

export function nativePickerObservation({ application, getDriverIdentity, output, artifacts }) {
  return async (name) => {
    assert.equal(process.platform, "win32");
    assert.match(name, /^[a-z0-9-]+$/u);
    const driver = getDriverIdentity();
    assert.ok(
      driver?.pid > 0 && path.isAbsolute(driver.path),
      "Captured launch driver is required",
    );
    assert.match(driver.started_filetime, /^[0-9]+$/u);
    const before = path.join(output, `${name}-before-cancel.json`);
    const result = spawnCommand(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./native-confirmation.ps1", import.meta.url)),
        "-DriverProcessId",
        String(driver.pid),
        "-ExpectedDriverPath",
        driver.path,
        "-ExpectedDriverStartedFiletime",
        driver.started_filetime,
        "-ObservationPath",
        before,
        "-ApplicationPath",
        application,
        "-ObservePicker",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    for (const record of [before, `${before}.window-samples.jsonl`])
      if (
        await stat(record).then(
          () => true,
          () => false,
        )
      )
        artifacts.push(record);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observation = JSON.parse(result.stdout);
    const report = path.join(output, `${name}.json`);
    await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" });
    artifacts.push(report);
    return observation;
  };
}

export function nativeConfirmation({ application, getDriverPid, output, artifacts }) {
  return async (
    title,
    button,
    expectedText,
    name,
    filePath,
    directoryPath,
    captureWindow = false,
  ) => {
    assert.equal(
      process.platform,
      "win32",
      "Owned native confirmation automation currently requires Windows",
    );
    await validatePickerInput({ output, title, button, filePath, directoryPath });
    if (captureWindow)
      assert.match(name, /^[a-z0-9-]+$/u, "Native evidence names must be simple owned file names");
    const screenshot = captureWindow ? path.join(output, `${name}.png`) : null;
    const result = spawnCommand(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./native-confirmation.ps1", import.meta.url)),
        "-DriverProcessId",
        String(getDriverPid()),
        "-ApplicationPath",
        application,
        "-Title",
        title,
        "-ExpectedText",
        expectedText,
        "-Button",
        button,
        ...(filePath ? ["-FilePath", filePath] : []),
        ...(directoryPath ? ["-DirectoryPath", directoryPath] : []),
        ...(screenshot ? ["-ScreenshotPath", screenshot] : []),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const observation = JSON.parse(result.stdout);
    const report = path.join(output, `${name}.json`);
    await writeFile(report, JSON.stringify(observation, null, 2), {
      flag: "wx",
    });
    artifacts.push(report);
    if (screenshot) {
      assert.ok((await stat(screenshot)).size > 0, "Actual native window screenshot is required");
      artifacts.push(screenshot);
    }
    return observation;
  };
}
