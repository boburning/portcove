import type { SpawnSyncReturns, ChildProcess } from "node:child_process";
import { isRecord } from "../../../scripts/runtime-values.mts";
import type { CapturedNativeProcess } from "./desktop-owned-native-session.mts";
interface EvidenceContext {
  output: string;
  artifacts: string[];
}
type CapturedDriver = CapturedNativeProcess;
interface LinuxPickerLaunch {
  child: Pick<ChildProcess, "pid">;
  receipt: { ready?: unknown; exit?: unknown; nonce: string; events: readonly { kind: string }[] };
}
export interface NativePickerContext extends EvidenceContext {
  application: string;
  getDriverIdentity?: () => CapturedDriver | undefined;
  getLinuxLaunch?: () => LinuxPickerLaunch | undefined;
  gameFilePicker?: boolean;
}
interface PickerInput {
  output: string;
  title: string;
  button: string;
  filePath?: string | undefined;
  directoryPath?: string | undefined;
}
// UI automation is limited to one exact executable descended from this harness's driver.
import assert from "node:assert/strict";
import path from "node:path";
import { lstat, stat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnCommand } from "../../../scripts/dev-storage.mts";

async function retainPickerObservation(
  result: SpawnSyncReturns<string>,
  output: string,
  name: string,
  artifacts: string[],
) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observation: unknown = JSON.parse(result.stdout);
  const report = path.join(output, `${name}.json`);
  await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" });
  artifacts.push(report);
  return observation;
}

async function validatePickerInput({
  output,
  title,
  button,
  filePath,
  directoryPath,
}: PickerInput) {
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
    assert.ok(["Choose Portcove library", "Choose game-file folder"].includes(title));
    assert.equal(button, "Select Folder");
    assert.ok((await stat(directoryPath)).isDirectory(), "Owned picker fixture is not a directory");
  }
}

async function retainPickerResult(
  { output, artifacts }: EvidenceContext,
  name: string,
  before: string,
  result: SpawnSyncReturns<string>,
) {
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
  const observation = await retainPickerObservation(result, output, name, artifacts);
  return observation;
}

function ownedRuntimePicker(
  {
    application,
    getDriverIdentity,
    output,
    artifacts,
    gameFilePicker = false,
  }: NativePickerContext,
  select: boolean,
) {
  return async (name: string, directoryPath?: string) => {
    assert.equal(process.platform, "win32");
    assert.match(name, /^[a-z0-9-]+$/u);
    if (select) {
      assert.equal(typeof directoryPath, "string");
      assert(directoryPath !== undefined);
      if (gameFilePicker) {
        await validatePickerInput({
          output,
          title: "Choose game-file folder",
          button: "Select Folder",
          directoryPath,
        });
      } else {
        const admitted = [
          "player-owned-runtime",
          "real-prepared-runtime-dkc3-recomp",
          "real-prepared-runtime-wave-race-64-racewave46",
          "upstream-downloads",
        ].map((name) => path.join(output, name));
        assert.ok(
          admitted.includes(directoryPath),
          "Exact owned prepared-runtime directory required",
        );
      }
      const directory = await lstat(directoryPath);
      assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
    } else assert.equal(directoryPath, undefined, "Observation cannot supply directory input");
    assert(getDriverIdentity, "Captured launch driver is required");
    const driver = getDriverIdentity();
    assert.ok(
      driver && driver.pid > 0 && path.isAbsolute(driver.path),
      "Captured launch driver is required",
    );
    assert(driver);
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
        ...(gameFilePicker ? ["-ExpectedPickerTitle", "Choose game-file folder"] : []),
        ...(select && directoryPath !== undefined
          ? ["-PreparedRuntimeDirectory", directoryPath]
          : []),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    return retainPickerResult({ output, artifacts }, name, before, result);
  };
}

export function nativePickerObservation(options: NativePickerContext) {
  return ownedRuntimePicker(options, false);
}

export function nativePreparedRuntimePicker(options: NativePickerContext) {
  return ownedRuntimePicker(options, true);
}

export function nativeGameFileFolderPicker(options: NativePickerContext) {
  if (process.platform === "linux") return ownedLinuxGameFilePicker(options);
  return (name: string, directoryPath?: string) =>
    ownedRuntimePicker({ ...options, gameFilePicker: true }, Boolean(directoryPath))(
      name,
      directoryPath,
    );
}

function ownedLinuxGameFilePicker({
  application,
  getLinuxLaunch,
  output,
  artifacts,
}: NativePickerContext) {
  return async (name: string, directoryPath?: string) => {
    assert.match(name, /^[a-z0-9-]+$/u);
    if (directoryPath)
      await validatePickerInput({
        output,
        title: "Choose game-file folder",
        button: "Select Folder",
        directoryPath,
      });
    assert(getLinuxLaunch, "Captured Linux launch is required");
    const launch = getLinuxLaunch();
    assert.ok(
      launch &&
        launch.child.pid !== undefined &&
        launch.child.pid > 1 &&
        launch.receipt.ready &&
        !launch.receipt.exit,
    );
    assert(launch && launch.child.pid !== undefined);
    assert.ok(launch.receipt.events.some((event) => event.kind === "driver-started"));
    const processState = await readFile(`/proc/${launch.child.pid}/stat`, "utf8");
    const started = processState
      .slice(processState.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u)[19];
    assert(started, "Launch process start identity is required");
    const sha256 = createHash("sha256")
      .update(await readFile(application))
      .digest("hex");
    const interpreter = await readFile("/usr/bin/python3");
    const interpreterIdentity = {
      path: "/usr/bin/python3",
      bytes: interpreter.length,
      sha256: createHash("sha256").update(interpreter).digest("hex"),
    };
    const result = spawnCommand(
      "/usr/bin/python3",
      [
        fileURLToPath(new URL("./native-linux-folder-picker.py", import.meta.url)),
        "--launch-pid",
        String(launch.child.pid),
        "--launch-started",
        started,
        "--launch-nonce",
        launch.receipt.nonce,
        "--application",
        application,
        "--application-sha256",
        sha256,
        "--output",
        output,
        ...(directoryPath ? ["--directory", directoryPath] : []),
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    const retained = path.join(output, `${name}-helper-result.json`);
    await writeFile(
      retained,
      JSON.stringify(
        {
          interpreter: interpreterIdentity,
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
    artifacts.push(retained);
    const observation = await retainPickerObservation(result, output, name, artifacts);
    return observation;
  };
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

interface FailureLocation {
  script: string;
  line: number;
  column: number;
}
function validFailureLocation(location: unknown): location is FailureLocation | null {
  if (location === null) return true;
  const integer = (number: unknown): number is number =>
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 0 &&
    number <= 1_000_000;
  return Boolean(
    isRecord(location) &&
    typeof location.script === "string" &&
    ["native-confirmation.ps1", "native-process-tree.ps1", "other"].includes(location.script) &&
    integer(location.line) &&
    location.line > 0 &&
    integer(location.column),
  );
}

interface FailureException {
  type: string;
  hresult: string;
}
function validFailureExceptions(exceptions: unknown): exceptions is FailureException[] {
  return (
    Array.isArray(exceptions) &&
    exceptions.length <= 4 &&
    exceptions.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.type === "string" &&
        failureTypes.includes(entry.type) &&
        typeof entry.hresult === "string" &&
        /^0x[0-9A-F]{8}$/u.test(entry.hresult),
    )
  );
}

function projectFailureDiagnostic(value: unknown) {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    typeof value.stage !== "string" ||
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
    ...(value.picker_fields == null
      ? {}
      : { picker_fields: projectPickerFields(value.picker_fields) }),
  };
}

interface NativeEdit {
  control_id: number;
  parent_id: number;
  parent_class: string;
  uia_control_type: number;
  owned: boolean | null;
  value_pattern: boolean | null;
}
interface PickerSample {
  name_kind: string;
  automation_id: string;
  owned: boolean;
  enabled: boolean;
}
const counters = [
  "folder_label_type",
  "folder_descendant_owned_edits",
  "owned_labeled_folder_edits",
  "folder_matches",
  "total_count",
  "automation_element_count",
  "folder_label_count",
  "owned_folder_matches",
  "folder_name_matches",
  "file_name_matches",
  "empty_name_matches",
] as const;
type PickerCounters = { [Key in (typeof counters)[number]]: number };
interface PickerFields extends PickerCounters {
  edit_count: number;
  truncated: boolean;
  native_edits: NativeEdit[];
  samples: PickerSample[];
}
function validNativeEdit(entry: unknown): entry is NativeEdit {
  return (
    isRecord(entry) &&
    typeof entry.control_id === "number" &&
    Number.isSafeInteger(entry.control_id) &&
    typeof entry.parent_id === "number" &&
    Number.isSafeInteger(entry.parent_id) &&
    typeof entry.parent_class === "string" &&
    ["ComboBox", "ComboBoxEx32", "other"].includes(entry.parent_class) &&
    typeof entry.uia_control_type === "number" &&
    Number.isSafeInteger(entry.uia_control_type) &&
    (entry.uia_control_type === 0 ||
      (entry.uia_control_type >= 50000 && entry.uia_control_type <= 50040)) &&
    (entry.owned === null || typeof entry.owned === "boolean") &&
    (entry.value_pattern === null || typeof entry.value_pattern === "boolean")
  );
}
function validPickerSample(entry: unknown): entry is PickerSample {
  return (
    isRecord(entry) &&
    typeof entry.name_kind === "string" &&
    ["folder", "file-name", "folder-name", "empty", "other"].includes(entry.name_kind) &&
    typeof entry.automation_id === "string" &&
    /^(?:[0-9]{1,8}|other)$/u.test(entry.automation_id) &&
    typeof entry.owned === "boolean" &&
    typeof entry.enabled === "boolean"
  );
}
function validPickerFields(value: unknown): value is PickerFields {
  return (
    isRecord(value) &&
    Array.isArray(value.native_edits) &&
    value.native_edits.length <= 8 &&
    value.native_edits.every(validNativeEdit) &&
    typeof value.edit_count === "number" &&
    Number.isSafeInteger(value.edit_count) &&
    value.edit_count >= 0 &&
    value.edit_count <= 1_000_000 &&
    Array.isArray(value.samples) &&
    value.samples.length === Math.min(value.edit_count, 16) &&
    value.truncated === value.edit_count > 16 &&
    value.samples.every(validPickerSample) &&
    counters.every((key) => {
      const count = value[key];
      return (
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= (key === "folder_matches" ? -1 : 0) &&
        count <= 1_000_000
      );
    })
  );
}
function projectPickerFields(value: unknown) {
  if (!validPickerFields(value)) return null;
  return {
    edit_count: value.edit_count,
    truncated: value.truncated,
    native_edits: value.native_edits.map(
      ({ control_id, parent_id, parent_class, uia_control_type, owned, value_pattern }) => ({
        control_id,
        parent_id,
        parent_class,
        uia_control_type,
        owned,
        value_pattern,
      }),
    ),
    ...Object.fromEntries(counters.map((key) => [key, value[key]])),
    samples: value.samples.map(({ name_kind, automation_id, owned, enabled }) => ({
      name_kind,
      automation_id,
      owned,
      enabled,
    })),
  };
}

function confirmationFailureDiagnostic(stderr: string) {
  try {
    const marker = "PORTCOVE_NATIVE_FAILURE ";
    const line = stderr?.split(/\r?\n/u).find((value: string) => value.startsWith(marker));
    if (!line || line.length > 4096) return null;
    return projectFailureDiagnostic(JSON.parse(line.slice(marker.length)));
  } catch {
    return null;
  }
}

async function retainConfirmationFailure(
  { output, artifacts }: EvidenceContext,
  name: string,
  result: SpawnSyncReturns<string>,
) {
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

export function nativeConfirmation({
  application,
  getDriverPid,
  output,
  artifacts,
}: EvidenceContext & { application: string; getDriverPid: () => number | undefined }) {
  return async (
    title: string,
    button: string,
    expectedText: string,
    name: string,
    filePath?: string,
    directoryPath?: string,
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
    const observation = await retainPickerObservation(result, output, name, artifacts);
    if (screenshot) {
      assert.ok((await stat(screenshot)).size > 0, "Actual native window screenshot is required");
      artifacts.push(screenshot);
    }
    return observation;
  };
}
