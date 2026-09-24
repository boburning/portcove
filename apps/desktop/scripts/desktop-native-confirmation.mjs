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

export function nativeConfirmation({ application, getDriverPid, output, artifacts }) {
  return async (title, button, expectedText, name, filePath, directoryPath) => {
    assert.equal(
      process.platform,
      "win32",
      "Owned native confirmation automation currently requires Windows",
    );
    await validatePickerInput({ output, title, button, filePath, directoryPath });
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
    return observation;
  };
}
