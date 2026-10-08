// UI automation is limited to one exact executable descended from this harness's driver.
import assert from "node:assert/strict";
import path from "node:path";
import { lstat, stat, writeFile } from "node:fs/promises";
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

async function retainPickerResult({ output, artifacts }, name, before, result) {
  for (const record of [before, `${before}.window-samples.jsonl`, `${before}.close-samples.json`])
    if (
      await stat(record).then(
        () => true,
        () => false,
      )
    )
      artifacts.push(record);
  const execution = path.join(output, `${name}-helper-result.json`);
  await writeFile(
    execution,
    JSON.stringify(
      {
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  artifacts.push(execution);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observation = JSON.parse(result.stdout);
  const report = path.join(output, `${name}.json`);
  await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" });
  artifacts.push(report);
  return observation;
}

function ownedRuntimePicker({ application, getDriverIdentity, output, artifacts }, select) {
  return async (name, directoryPath) => {
    assert.equal(process.platform, "win32");
    assert.match(name, /^[a-z0-9-]+$/u);
    if (select) {
      assert.equal(directoryPath, path.join(output, "player-owned-runtime"));
      const directory = await lstat(directoryPath);
      assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
    } else assert.equal(directoryPath, undefined, "Observation cannot supply directory input");
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
        ...(select ? ["-PreparedRuntimeDirectory", directoryPath] : []),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    return retainPickerResult({ output, artifacts }, name, before, result);
  };
}

export function nativePickerObservation(options) {
  return ownedRuntimePicker(options, false);
}

export function nativePreparedRuntimePicker(options) {
  return ownedRuntimePicker(options, true);
}

const failureStages = [
  "setup",
  "automation-assemblies-start",
  "automation-assemblies-ready",
  "owned-process-tree-start",
  "owned-process-tree-ready",
  "exact-root-discovery-start",
  "exact-root-discovery-ready",
  "owned-root-discovery-start",
  "owned-root-discovery-ready",
  "nested-discovery-start",
  "nested-discovery-ready",
  "candidate-descendants-start",
  "candidate-descendants-ready",
  "candidate-text-ready",
  "timeout-roots-start",
  "timeout-nested-start",
  "button-descendants-start",
  "button-descendants-ready",
  "target-identity-rechecked",
  "screenshot-preparation-start",
  "screenshot-written",
  "observation-complete",
  "unknown",
];
const failureTypes = [
  "System.Exception",
  "System.InvalidOperationException",
  "System.ArgumentException",
  "System.IO.IOException",
  "System.UnauthorizedAccessException",
  "System.Runtime.InteropServices.COMException",
  "System.Management.Automation.RuntimeException",
  "System.Management.Automation.MethodInvocationException",
  "System.Management.Automation.ActionPreferenceStopException",
  "System.Windows.Automation.ElementNotAvailableException",
  "System.Windows.Automation.ElementNotEnabledException",
  "other",
];

function validFailureLocation(location) {
  if (location === null) return true;
  const integer = (number) => Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000;
  return Boolean(
    location &&
    ["native-confirmation.ps1", "native-process-tree.ps1", "other"].includes(location.script) &&
    integer(location.line) &&
    location.line > 0 &&
    integer(location.column),
  );
}

function validFailureExceptions(exceptions) {
  return (
    Array.isArray(exceptions) &&
    exceptions.length <= 4 &&
    exceptions.every(
      (entry) => failureTypes.includes(entry?.type) && /^0x[0-9A-F]{8}$/u.test(entry?.hresult),
    )
  );
}

function confirmationFailureDiagnostic(stderr) {
  try {
    const marker = "PORTCOVE_NATIVE_FAILURE ";
    const line = stderr?.split(/\r?\n/u).find((value) => value.startsWith(marker));
    if (!line || line.length > 4096) return null;
    const value = JSON.parse(line.slice(marker.length));
    if (
      value?.format_version !== 1 ||
      !failureStages.includes(value.stage) ||
      !validFailureExceptions(value.exceptions) ||
      typeof value.exceptions_truncated !== "boolean" ||
      !validFailureLocation(value.location)
    )
      return null;
    return {
      format_version: 1,
      stage: value.stage,
      location: value.location && {
        script: value.location.script,
        line: value.location.line,
        column: value.location.column,
      },
      exceptions: value.exceptions.map(({ type, hresult }) => ({ type, hresult })),
      exceptions_truncated: value.exceptions_truncated,
    };
  } catch {
    return null;
  }
}

async function retainConfirmationFailure({ output, artifacts }, name, result) {
  try {
    // The helper emits only fixed identifiers and numeric fields. Do not retain
    // its ordinary stderr, which can contain window text or private paths.
    const diagnostic = confirmationFailureDiagnostic(result.stderr);
    const receipt = path.join(output, `${name}-helper-result.json`);
    await writeFile(
      receipt,
      JSON.stringify(
        {
          status: result.status,
          signal: result.signal,
          spawn_error: Boolean(result.error),
          diagnostic,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(receipt);
  } catch {
    // The original child failure remains primary even if capture cannot finish.
  }
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
    if (result.status !== 0) await retainConfirmationFailure({ output, artifacts }, name, result);
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
