/**
 * Hosted installed-update acceptance (#52) on a disposable GitHub-hosted
 * Windows runner. It installs a published release from public HTTPS, seeds an
 * isolated configuration and library, proves the shipping updater refuses while
 * another Portcove process (the release CLI held at its confirmation prompt)
 * uses the library, then lets the shipping updater install the production
 * feed's newer version and checks the result.
 *
 * Every Portcove process gets explicit configuration, library, runtime-lease,
 * update-preference, temporary and WebView2 locations under `--work`. Nothing
 * here authenticates, signs or publishes. Evidence goes to `--output`.
 * Run only from `.github/workflows/hosted-installed-update.yml`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { By, until, type WebDriver } from "selenium-webdriver";
import {
  awaitInstalledUpdateDriver,
  connectInstalledUpdateDriver,
  hashFile,
  startInstalledUpdateDriver,
} from "./desktop-installed-update-harness.mts";
import { openInstalledUpdateSettings } from "./desktop-application-update-journey.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
import {
  appearedSince,
  channels,
  cliData,
  compareVersions,
  defaultFolders,
  fetchBounded,
  fromReleaseTag,
  holdPortFromCatalogList,
  isolationMarkers,
  localeUrl,
  manifestDifferences,
  observeFeed,
  parseSha256Sums,
  playerDataSeed,
  releaseAssetUrl,
  sha256,
  updateCopy,
  updatePreferenceBytes,
  verifyAgainstSums,
  windowsAssetNames,
  windowsPathKey,
  type Channel,
  type LocationSnapshot,
  type ManifestEntry,
} from "../../../scripts/hosted-installed-update.mts";

const { values } = parseArgs({
  options: {
    "from-version": { type: "string" },
    "from-tag": { type: "string", default: "" },
    channel: { type: "string", default: "preview" },
    work: { type: "string" },
    output: { type: "string" },
    "tool-state": { type: "string" },
  },
  strict: true,
});
function required(name: keyof typeof values) {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
}
assert.equal(process.platform, "win32", "the hosted installed-update acceptance runs on Windows");
const fromVersion = required("from-version");
const fromTag = fromReleaseTag(fromVersion, values["from-tag"]);
const channel = required("channel") as Channel;
assert.ok(channels.includes(channel), `unknown channel ${channel}`);
const work = path.resolve(required("work"));
const output = path.resolve(required("output"));
// NSIS takes `/D=` unquoted as its last argument, so the install root has no spaces.
assert.ok(!/\s/u.test(work), "the work root must not contain whitespace");

const scope = {
  install: path.join(work, "installed"),
  config: path.join(work, "scope", "config"),
  library: path.join(work, "scope", "library"),
  temp: path.join(work, "scope", "temp"),
  webview: path.join(work, "scope", "webview2"),
  downloads: path.join(work, "downloads"),
  tools: path.join(work, "tools"),
};
const application = path.join(scope.install, "portcove-desktop.exe");
const preferencesFile = path.join(scope.config, "application-update-preferences.json");
const isolatedEnvironment = {
  PORTCOVE_LIBRARY: scope.library,
  PORTCOVE_PREFERENCES: path.join(scope.config, "preferences.json"),
  PORTCOVE_APPLICATION_UPDATE_PREFERENCES: preferencesFile,
  PORTCOVE_APPLICATION_RUNTIME_LOCK: path.join(scope.config, "application-runtime.lock"),
  PORTCOVE_TEMP_DIR: scope.temp,
  WEBVIEW2_USER_DATA_FOLDER: scope.webview,
};
/** Every Portcove child sees only the isolated scope, never inherited overrides. */
function portcoveEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (!name.toUpperCase().startsWith("PORTCOVE_")) environment[name] = value;
  return { ...environment, ...isolatedEnvironment };
}

/**
 * The NSIS `/R` relaunch does not inherit the installer's environment. From an
 * elevated installer (hosted runners are elevated), tauri-bundler's template calls
 * `nsis_tauri_utils::RunAsUser`, which uses `CreateProcessWithTokenW` with
 * Explorer's token and no environment block, so Windows builds the app's
 * environment from the user profile, including HKCU\Environment. The harness
 * therefore writes the isolated scope there (a broadcast alone would not reach
 * it). Previous values are read before anything is written, so a partial
 * publish is still restored when the run ends.
 */
let publishedUserEnvironment: Record<string, string | null> | null = null;
function userEnvironment(names: string[]) {
  return powershellJson(
    `$previous = [ordered]@{}
    foreach ($name in ($env:HOSTED_NAMES | ConvertFrom-Json)) {
      $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'User')
    }
    ConvertTo-Json -InputObject $previous -Compress`,
    { NAMES: JSON.stringify(names) },
  ) as Record<string, string | null>;
}
function setUserEnvironment(values: Record<string, string | null>) {
  powershell(
    `$values = $env:HOSTED_VALUES | ConvertFrom-Json -AsHashtable
    foreach ($name in $values.Keys) { [Environment]::SetEnvironmentVariable($name, $values[$name], 'User') }`,
    { VALUES: JSON.stringify(values) },
  );
}
function publishIsolationToUserEnvironment() {
  publishedUserEnvironment = userEnvironment(Object.keys(isolatedEnvironment));
  report.relaunch_environment = {
    published: Object.keys(isolatedEnvironment),
    previous: publishedUserEnvironment,
  };
  setUserEnvironment(isolatedEnvironment);
}
function restoreUserEnvironment() {
  if (!publishedUserEnvironment) return;
  setUserEnvironment(publishedUserEnvironment);
  publishedUserEnvironment = null;
}

interface Check {
  name: string;
  outcome: "passed" | "failed" | "skipped";
  at: string;
  detail?: unknown;
}
const report: Record<string, unknown> & {
  timeline: { at: string; event: string; detail?: unknown }[];
  checks: Check[];
} = {
  schema_version: 1,
  outcome: "running",
  scope:
    "Disposable GitHub-hosted Windows runner (administrator account), published release from public HTTPS, production feed, shipping updater. Not ordinary-user, physical-device or minimum-OS evidence.",
  inputs: { from_version: fromVersion, from_tag: fromTag, channel },
  isolation: isolatedEnvironment,
  install_root: scope.install,
  timeline: [],
  checks: [],
};
/** Rewritten after every event and check so a job timeout keeps the evidence. */
function persist() {
  try {
    writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(`report.json could not be written: ${errorMessage(error)}`);
  }
}
function event(name: string, detail?: unknown) {
  report.timeline.push({ at: new Date().toISOString(), event: name, detail });
  console.log(
    `[${new Date().toISOString()}] ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`,
  );
  persist();
}
function check(name: string, passed: boolean, detail?: unknown) {
  report.checks.push({
    name,
    outcome: passed ? "passed" : "failed",
    at: new Date().toISOString(),
    detail,
  });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  persist();
  if (!passed) throw new Error(`check failed: ${name} ${JSON.stringify(detail)}`);
}
/** Records a failed check without stopping, so later evidence is still gathered;
 * the run fails at the end when any deferred check failed. */
const deferredFailures: string[] = [];
function checkDeferred(name: string, passed: boolean, detail?: unknown) {
  try {
    check(name, passed, detail);
  } catch {
    deferredFailures.push(name);
  }
}
function skip(name: string, reason: string) {
  report.checks.push({ name, outcome: "skipped", at: new Date().toISOString(), detail: reason });
  console.log(`SKIP ${name}: ${reason}`);
  persist();
}

/** Thrown by a wait predicate to stop waiting at once (for example, a child exited). */
class StopWaiting extends Error {}
/** Polls until the predicate returns a value. Ordinary predicate errors are
 * retried and the last one is named on timeout; `StopWaiting` ends the wait. */
async function waitUntil<Value>(
  predicate: () => Promise<Value>,
  label: string,
  deadlineMs: number,
): Promise<NonNullable<Value>> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      if (error instanceof StopWaiting) throw error;
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${label} did not complete within ${deadlineMs} ms${last === undefined ? "" : `; last error: ${errorMessage(last)}`}`,
  );
}

/** Runs a fixed PowerShell snippet; inputs travel as environment values only. */
function powershell(script: string, inputs: Record<string, string> = {}, timeout = 120_000) {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'\n${script}`],
    {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`HOSTED_${k}`, v])),
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `PowerShell failed (${result.status}): ${result.error?.message ?? ""} ${result.stderr}`,
    );
  return result.stdout;
}
function powershellJson(script: string, inputs: Record<string, string> = {}): unknown {
  const text = powershell(script, inputs).trim();
  return text ? JSON.parse(text) : null;
}

function uninstallEntries() {
  const entries = powershellJson(
    `$found = foreach ($hive in 'HKCU','HKLM') {
      Get-ChildItem "$($hive):\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
        Where-Object { $_.DisplayName -eq 'Portcove' } |
        ForEach-Object { [ordered]@{ hive = $hive; key = $_.PSChildName; display_version = [string]$_.DisplayVersion; install_location = [string]$_.InstallLocation; uninstall = [string]$_.UninstallString } }
    }
    ConvertTo-Json -InputObject @($found) -Depth 3`,
  );
  assert.ok(Array.isArray(entries));
  return entries.filter(isRecord);
}
function executableVersion(file: string) {
  return powershellJson(
    `$v = (Get-Item -LiteralPath $env:HOSTED_FILE).VersionInfo
    [ordered]@{ file_version = [string]$v.FileVersion; product_version = [string]$v.ProductVersion; product_name = [string]$v.ProductName } | ConvertTo-Json`,
    { FILE: file },
  );
}
interface ProcessRow {
  pid: number;
  parent: number;
  name: string;
  path: string | null;
  command_line: string | null;
}
function applicationProcesses(): ProcessRow[] {
  const rows = powershellJson(
    `$rows = Get-CimInstance Win32_Process -Filter "Name = 'portcove-desktop.exe'" |
      ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = [string]$_.Name; path = $_.ExecutablePath; command_line = $_.CommandLine } }
    ConvertTo-Json -InputObject @($rows) -Depth 3`,
  );
  assert.ok(Array.isArray(rows));
  return rows as ProcessRow[];
}
function installedApplicationProcesses() {
  return applicationProcesses().filter(
    (row) => row.path && windowsPathKey(row.path) === windowsPathKey(application),
  );
}
function processAlive(pid: number) {
  return (
    powershell(
      `if (Get-Process -Id ([int]$env:HOSTED_PID) -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
      {
        PID: String(pid),
      },
    ).trim() === "yes"
  );
}

/** Existence of the broad default folders (observed) and of the override-sensitive
 * markers (checked). See `isolationMarkers` for why only markers are checked. */
function snapshot(locations: string[]): LocationSnapshot {
  return Object.fromEntries(locations.map((location) => [location, existsSync(location)]));
}
const localAppData = process.env.LOCALAPPDATA ?? "";
const roamingAppData = process.env.APPDATA ?? "";
const folderSnapshot = () => snapshot(defaultFolders(localAppData, roamingAppData));
const markerSnapshot = () => snapshot(isolationMarkers(localAppData));

/** The registration names the isolated root; NSIS may record only the uninstaller. */
function registrationInstallRoot(entry: Record<string, unknown> | undefined) {
  const clean = windowsPathKey;
  const expected = clean(scope.install);
  const location = typeof entry?.install_location === "string" ? entry.install_location : "";
  if (location.trim())
    return { source: "InstallLocation", matches: clean(location) === expected, location };
  const uninstall = typeof entry?.uninstall === "string" ? entry.uninstall : "";
  const executable = /^"?([^"]+?\.exe)"?/iu.exec(uninstall)?.[1];
  const directory = executable ? path.win32.dirname(executable) : "";
  return {
    source: "UninstallString",
    matches: Boolean(directory) && clean(directory) === expected,
    location: directory,
  };
}

async function manifest(root: string, relative = ""): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  const directory = path.join(root, relative);
  for (const name of (await readdir(directory)).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const info = await lstat(path.join(root, child));
    assert.ok(!info.isSymbolicLink(), `unexpected link in player data: ${child}`);
    if (info.isDirectory()) entries.push(...(await manifest(root, child)));
    else entries.push({ path: child, ...(await hashFile(path.join(root, child))) });
  }
  return entries;
}
const userManifest = () => manifest(path.join(scope.library, "user"));

async function retain(name: string, bytes: Uint8Array | string) {
  await writeFile(path.join(output, name), bytes);
}

async function download(tag: string, asset: string, sums?: Map<string, string>) {
  const url = releaseAssetUrl(tag, asset);
  const fetchedAt = new Date().toISOString();
  const bytes = await fetchBounded(url, 512 * 1024 * 1024, 15 * 60_000);
  const verified = sums
    ? verifyAgainstSums(sums, asset, bytes)
    : { asset, sha256: sha256(bytes), bytes: bytes.byteLength };
  const directory = path.join(scope.downloads, tag);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, asset);
  await writeFile(file, bytes);
  event("downloaded", { url, fetched_at: fetchedAt, ...verified });
  return { file, url, fetched_at: fetchedAt, ...verified };
}
async function releaseSums(tag: string) {
  const bytes = await fetchBounded(releaseAssetUrl(tag, "SHA256SUMS"), 64 * 1024);
  await retain(`SHA256SUMS-${tag}.txt`, bytes);
  return parseSha256Sums(bytes.toString("utf8"));
}
async function releaseCopy(tag: string) {
  const bytes = await fetchBounded(localeUrl(tag), 256 * 1024);
  await retain(`applicationUpdate-${tag}.json`, bytes);
  return updateCopy(JSON.parse(bytes.toString("utf8")));
}

async function extractCli(zip: string, version: string) {
  const destination = path.join(scope.tools, `cli-${version}`);
  powershell(
    `Expand-Archive -LiteralPath $env:HOSTED_ZIP -DestinationPath $env:HOSTED_DEST -Force`,
    {
      ZIP: zip,
      DEST: destination,
    },
  );
  const cli = path.join(destination, "portcove.exe");
  assert.ok(existsSync(cli), "the CLI ZIP did not contain portcove.exe");
  return cli;
}
function runCli(cli: string, args: string[]) {
  const result = spawnSync(cli, args, {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    env: portcoveEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function cliJson(cli: string, args: string[], command: string) {
  const result = runCli(cli, ["--json", ...args]);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return cliData(JSON.parse(result.stdout), command);
}

/** The release CLI waits at `output reset`'s confirmation prompt. While it waits
 * it holds the shared application runtime lease and an open library, exactly as
 * a player's command-line session would. Answering "n" cancels with no change. */
async function holdLibraryWithCli(cli: string) {
  const port = holdPortFromCatalogList(
    JSON.parse(runCli(cli, ["--json", "catalog", "list"]).stdout),
  );
  const preview = cliJson(cli, ["output", "preview", port], "output.preview");
  const previewSha = preview.preview_sha256;
  assert.ok(typeof previewSha === "string" && /^[a-f0-9]{64}$/u.test(previewSha));
  const child = spawn(cli, ["output", "reset", port, "--expected-preview", previewSha], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: portcoveEnvironment(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-65536)));
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-65536)));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  await waitUntil(
    async () => {
      if (child.exitCode !== null)
        throw new StopWaiting(`CLI exited early (${String(child.exitCode)}): ${stderr}`);
      return stderr.includes("[y/N]");
    },
    "CLI confirmation prompt",
    60_000,
  );
  event("cli-holding-library", { pid: child.pid, port, preview_sha256: previewSha });
  return {
    pid: child.pid,
    port,
    previewSha,
    async release() {
      child.stdin.end("n\n");
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 60_000)),
      ]);
      if (code === "timeout") child.kill();
      await retain(
        "cli-hold.log",
        `exit=${String(code)}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`,
      );
      return { code, stdout, stderr };
    },
  };
}

interface Session {
  browser: WebDriver;
  driver: ChildProcess;
  driverLog: () => string;
}
async function startSession(
  label: string,
  toolState: { tauri: string; native: string },
): Promise<Session> {
  check(`driver-ports-free-before-${label}`, await driverPortsFree(), driverPorts);
  const started = startInstalledUpdateDriver(toolState.tauri, toolState.native, {
    env: portcoveEnvironment(),
    windowsHide: true,
  });
  await awaitInstalledUpdateDriver(started.driver);
  const browser = await connectInstalledUpdateDriver(application, scope.webview);
  await browser.manage().setTimeouts({ script: 60_000 });
  await browser.wait(
    async () =>
      executeBrowserScript(
        browser,
        () =>
          document.querySelector('nav[aria-label="Primary navigation"]') !== null &&
          document.querySelector(".loading-state") === null,
      ),
    120_000,
  );
  event("session-ready", { label });
  return { browser, driver: started.driver, driverLog: () => started.log };
}
async function endSession(session: Session, label: string) {
  await Promise.race([
    session.browser.quit().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 20_000)),
  ]);
  // tauri-driver's msedgedriver child would otherwise keep the fixed native port.
  if (session.driver.pid && session.driver.exitCode === null)
    spawnSync("taskkill.exe", ["/PID", String(session.driver.pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 15_000,
      stdio: "ignore",
    });
  await retain(`tauri-driver-${label}.log`, session.driverLog());
  await waitUntil(driverPortsFree, `driver ports free after ${label}`, 30_000);
  event("session-ended", { label });
}

const driverPorts = [45770, 45771];
function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function driverPortsFree() {
  return (await Promise.all(driverPorts.map(portFree))).every(Boolean);
}

async function screenshot(browser: WebDriver, name: string) {
  try {
    await mkdir(path.join(output, "screenshots"), { recursive: true });
    await writeFile(
      path.join(output, "screenshots", `${name}.png`),
      await browser.takeScreenshot(),
      "base64",
    );
    event("screenshot", { name });
  } catch (error) {
    event("screenshot-failed", { name, error: errorMessage(error) });
  }
}

async function invoke(browser: WebDriver, command: string): Promise<unknown> {
  const raw = await browser.executeAsyncScript<string>(
    (name: string, done: (value: string) => void) => {
      const bridge = (
        window as Window & { __TAURI_INTERNALS__?: { invoke(command: string): Promise<unknown> } }
      ).__TAURI_INTERNALS__;
      if (!bridge) return done('{"ok":false,"error":"no bridge"}');
      void bridge.invoke(name).then(
        (value) => done(JSON.stringify({ ok: true, value })),
        (error: unknown) => done(JSON.stringify({ ok: false, error })),
      );
    },
    command,
  );
  const result: unknown = JSON.parse(raw);
  assert.ok(isRecord(result) && result.ok === true, `${command} failed: ${raw.slice(0, 2048)}`);
  return result.value;
}
interface UpdateStatus {
  current_version: string;
  checking: boolean;
  installing: boolean;
  available: { version: string; channel: string } | null;
  last_checked_unix_seconds: number | null;
}
async function updateStatus(browser: WebDriver): Promise<UpdateStatus> {
  const status = await invoke(browser, "get_application_update_status");
  assert.ok(isRecord(status) && typeof status.current_version === "string");
  assert.ok(status.available === null || isRecord(status.available));
  return status as unknown as UpdateStatus;
}
async function updatePreferences(browser: WebDriver) {
  const preferences = await invoke(browser, "get_application_update_preferences");
  assert.ok(isRecord(preferences));
  return preferences;
}

function xpathText(text: string) {
  if (!text.includes('"')) return `"${text}"`;
  return `concat(${text
    .split('"')
    .map((part) => `"${part}"`)
    .join(`, '"', `)})`;
}
const updatePanel = '//article[@aria-labelledby="application-update-settings-title"]';
async function clickButton(browser: WebDriver, label: string, timeout = 60_000) {
  const locator = By.xpath(
    `${updatePanel}//button[normalize-space(.)=${xpathText(label)} and not(@disabled)]`,
  );
  const button = await browser.wait(until.elementLocated(locator), timeout);
  await browser.wait(until.elementIsEnabled(button), timeout);
  await button.click();
}
async function assertPreviewSelected(browser: WebDriver, label: string) {
  const pressed = await browser
    .findElement(
      By.xpath(
        `${updatePanel}//*[@aria-labelledby="application-update-channel-label"]//button[normalize-space(.)=${xpathText(label)}]`,
      ),
    )
    .getAttribute("aria-pressed");
  check("ui-shows-preview-channel", pressed === "true", { aria_pressed: pressed });
}
async function openLibrary(browser: WebDriver) {
  const first = await browser.findElement(By.css('nav[aria-label="Primary navigation"] button'));
  await first.click();
  await browser.wait(async () => (await first.getAttribute("aria-current")) === "page", 30_000);
}
async function alertText(browser: WebDriver) {
  const alerts = await browser.findElements(By.xpath(`${updatePanel}//p[@role="alert"]`));
  return alerts.length ? (await alerts[0]!.getText()).replace(/\s+/gu, " ").trim() : null;
}

const watcherScript = String.raw`param([int]$Root, [string]$Application, [int]$Seconds)
$ErrorActionPreference = 'Stop'
$tracked = @{ $Root = $true }
$exited = @{}
$ignored = @('msedgewebview2.exe', 'conhost.exe')
$deadline = (Get-Date).AddSeconds($Seconds)
function Emit($kind, $p) { [Console]::Out.WriteLine(([ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); kind = $kind; pid = [int]$p.ProcessId; parent = [int]$p.ParentProcessId; name = [string]$p.Name; path = $p.ExecutablePath; command_line = $p.CommandLine } | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
$initial = Get-CimInstance Win32_Process -Filter "ProcessId = $Root"
if ($initial) { Emit 'present' $initial } else { [Console]::Out.WriteLine('{"kind":"root-missing"}') }
$last = @{}
while ((Get-Date) -lt $deadline) {
  $all = @(Get-CimInstance Win32_Process)
  $alive = @{}
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    $alive[$id] = $p
    if ($tracked.ContainsKey($id) -or $ignored -contains ([string]$p.Name).ToLowerInvariant()) { continue }
    $relevant = $tracked.ContainsKey([int]$p.ParentProcessId) -or ([string]$p.Name -ieq 'portcove-desktop.exe') -or ([string]$p.CommandLine -match '(^|\s)/UPDATE(\s|$)')
    if ($relevant) { $tracked[$id] = $true; Emit 'started' $p }
  }
  foreach ($id in @($tracked.Keys)) {
    if ($alive.ContainsKey($id)) { $last[$id] = $alive[$id] }
    elseif (-not $exited.ContainsKey($id)) {
      $exited[$id] = $true
      if ($last.ContainsKey($id)) { Emit 'exited' $last[$id] } else { [Console]::Out.WriteLine(([ordered]@{ kind = 'exited'; pid = $id } | ConvertTo-Json -Compress)) }
    }
  }
  Start-Sleep -Milliseconds 500
}
`;
interface WatchedProcess {
  at?: string;
  kind: string;
  pid: number;
  parent?: number;
  name?: string;
  path?: string | null;
  command_line?: string | null;
}
async function watchProcesses(root: number, seconds: number) {
  const script = path.join(scope.tools, "watch-processes.ps1");
  await writeFile(script, watcherScript);
  const child = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-Root",
      String(root),
      "-Application",
      application,
      "-Seconds",
      String(seconds),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  const events: WatchedProcess[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-65536)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) {
        events.push(parsed as unknown as WatchedProcess);
        console.log(`process ${line}`);
      }
    } catch {
      stderr += `\nunparsed: ${line}`;
    }
  });
  return {
    events,
    async stop() {
      if (child.exitCode === null) child.kill();
      await retain(
        "process-watch.jsonl",
        `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n${stderr ? `# stderr\n${stderr}\n` : ""}`,
      );
    },
  };
}

function closeProcess(pid: number) {
  return powershellJson(
    `$p = Get-Process -Id ([int]$env:HOSTED_PID) -ErrorAction SilentlyContinue
    if (-not $p) { '{"result":"already-exited"}'; return }
    $closed = $p.CloseMainWindow()
    if ($p.WaitForExit(60000)) { [ordered]@{ result = 'closed'; close_requested = $closed; exit_code = $p.ExitCode } | ConvertTo-Json; return }
    Stop-Process -Id $p.Id -Force
    $p.WaitForExit(30000) | Out-Null
    [ordered]@{ result = 'stopped'; close_requested = $closed } | ConvertTo-Json`,
    { PID: String(pid) },
  );
}

async function readToolState(file: string) {
  const state: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(isRecord(state) && isRecord(state.desktop), "tool state lacks the desktop drivers");
  const { tauri_driver: tauri, native_driver: native } = state.desktop;
  assert.ok(typeof tauri === "string" && typeof native === "string");
  report.drivers = state.desktop;
  return { tauri, native };
}

async function main() {
  await mkdir(output, { recursive: true });
  for (const directory of Object.values(scope)) await mkdir(directory, { recursive: true });
  const tools = await readToolState(required("tool-state"));
  report.host = {
    image_os: process.env.ImageOS,
    image_version: process.env.ImageVersion,
    runner: process.env.RUNNER_NAME,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    source: process.env.GITHUB_SHA,
  };

  // 1. A fresh machine: no default Portcove location exists before anything runs.
  const foldersBefore = folderSnapshot();
  const markersBefore = markerSnapshot();
  report.default_locations_before = { folders: foldersBefore, markers: markersBefore };
  check(
    "no-default-portcove-locations-before",
    [...Object.values(foldersBefore), ...Object.values(markersBefore)].every((exists) => !exists),
    report.default_locations_before,
  );
  check("no-portcove-registration-before", uninstallEntries().length === 0);

  // 2. The from-version installer and CLI from its GitHub Release, verified.
  const fromAssets = windowsAssetNames(fromVersion);
  const fromSums = await releaseSums(fromTag);
  const fromInstaller = await download(fromTag, fromAssets.installer, fromSums);
  const fromCli = await extractCli(
    (await download(fromTag, fromAssets.cli, fromSums)).file,
    fromVersion,
  );
  const fromCopy = await releaseCopy(fromTag);
  report.from_release = {
    tag: fromTag,
    installer: fromInstaller,
    cli_sha256: (await hashFile(fromCli)).sha256,
  };

  // 3. Per-user silent install into the isolated root.
  event("installing", { installer: fromInstaller.file });
  const install = spawnSync(fromInstaller.file, ["/S", `/D=${scope.install}`], {
    timeout: 10 * 60_000,
    windowsHide: true,
  });
  check("from-install-exit-zero", install.status === 0 && !install.error, {
    status: install.status,
    error: install.error?.message,
  });
  check("from-installed-executable", existsSync(application));
  const fromRegistration = uninstallEntries();
  report.from_registration = fromRegistration;
  check(
    "from-registered-per-user",
    fromRegistration.length === 1 &&
      fromRegistration[0]?.hive === "HKCU" &&
      fromRegistration[0]?.display_version === fromVersion,
    fromRegistration,
  );
  const fromRoot = registrationInstallRoot(fromRegistration[0]);
  check("from-registration-names-isolated-install-root", fromRoot.matches, fromRoot);
  const fromExecutable = await hashFile(application);
  report.from_executable = { ...fromExecutable, version: executableVersion(application) };

  // 4. Isolated scope before the first launch: Preview preference, library
  // created by the release CLI, deterministic player data.
  await writeFile(preferencesFile, updatePreferenceBytes(channel));
  const preferenceHash = (await hashFile(preferencesFile)).sha256;
  const identityBefore = cliJson(fromCli, ["library", "identity"], "library.identity");
  check(
    "library-created-in-isolated-scope",
    typeof identityBefore.id === "string" &&
      typeof identityBefore.root === "string" &&
      windowsPathKey(identityBefore.root) === windowsPathKey(scope.library),
    identityBefore,
  );
  for (const file of playerDataSeed()) {
    const target = path.join(scope.library, ...file.relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
  }
  const userBefore = await userManifest();
  report.seed = {
    preference_sha256: preferenceHash,
    library_identity: identityBefore,
    user_manifest: userBefore,
  };
  event("scope-seeded", { files: userBefore.length });

  // 5. The feed right before the check: the version the app must offer.
  const feed = await observeFeed(channel);
  await retain("feed-at-check.json", feed.bytes);
  report.feed_at_check = {
    url: feed.url,
    fetched_at: feed.fetched_at,
    sha256: feed.sha256,
    offer: feed.offer,
  };
  check(
    "feed-offers-newer-version",
    compareVersions(feed.offer.version, fromVersion) > 0,
    feed.offer,
  );
  const toVersion = feed.offer.version;

  // 6. First session on the from-version: check, refuse while the CLI holds.
  publishIsolationToUserEnvironment();
  const first = await startSession("from", tools);
  // Second baseline: what the fully isolated app creates on its own (Tauri makes
  // `%LOCALAPPDATA%\io.github.portcove.portcove` regardless of the WebView2
  // override). It is an observation, never blamed on the relaunch.
  const markersIsolated = markerSnapshot();
  report.isolated_session_created = {
    folders: appearedSince(foldersBefore, folderSnapshot()),
    markers: appearedSince(markersBefore, markersIsolated),
  };
  event("isolated-session-baseline", report.isolated_session_created);
  let appPid: number;
  try {
    const browser = first.browser;
    const status = await updateStatus(browser);
    check("from-reports-installed-version", status.current_version === fromVersion, status);
    check("preference-read-by-app", (await updatePreferences(browser)).channel === channel);
    await screenshot(browser, "01-from-started");
    await openInstalledUpdateSettings(browser);
    await assertPreviewSelected(browser, fromCopy.preview);
    await screenshot(browser, "02-from-update-settings");
    await clickButton(browser, fromCopy.check);
    event("check-clicked");
    const offered = await waitUntil(
      async () => {
        const current = await updateStatus(browser);
        return !current.checking && current.available ? current : null;
      },
      "update offer",
      180_000,
    );
    check("app-offers-feed-version", offered.available?.version === toVersion, offered);
    const heading = await browser
      .findElement(By.id("application-update-available-title"))
      .getText();
    check(
      "offer-heading-names-version",
      heading.trim() === fromCopy.availableTitle.replace("{{version}}", toVersion),
      { heading },
    );
    await screenshot(browser, "03-update-offered");

    const owned = installedApplicationProcesses();
    check("one-installed-app-process", owned.length === 1, owned);
    appPid = owned[0]!.pid;
    report.from_process = owned[0];

    // Refusal: another Portcove process uses the library during the install.
    const hold = await holdLibraryWithCli(fromCli);
    await clickButton(browser, fromCopy.install);
    event("install-clicked-while-held");
    const refusal = await waitUntil(
      async () => {
        const text = await alertText(browser);
        return text ? text : null;
      },
      "update refusal",
      20 * 60_000,
    );
    await screenshot(browser, "04-refused-library-in-use");
    check(
      "refusal-shows-library-in-use-copy",
      refusal === fromCopy.libraryInUse.replace(/\s+/gu, " ").trim(),
      { refusal },
    );
    check("refused-app-still-running", processAlive(appPid), { pid: appPid });
    const afterRefusal = await waitUntil(
      async () => {
        const current = await updateStatus(browser);
        return current.installing ? null : current;
      },
      "install activity to end",
      60_000,
    );
    check("refused-version-unchanged", afterRefusal.current_version === fromVersion, afterRefusal);
    check(
      "refused-executable-unchanged",
      (await hashFile(application)).sha256 === fromExecutable.sha256,
    );
    check("refused-registration-unchanged", uninstallEntries()[0]?.display_version === fromVersion);
    check(
      "refused-offer-still-available",
      afterRefusal.available?.version === toVersion,
      afterRefusal,
    );
    await openLibrary(browser);
    await screenshot(browser, "05-usable-after-refusal");
    await openInstalledUpdateSettings(browser);
    const released = await hold.release();
    report.cli_hold = {
      pid: hold.pid,
      port: hold.port,
      preview_sha256: hold.previewSha,
      exit_code: released.code,
    };
    check(
      "cli-cancelled-without-change",
      released.code !== null && released.code !== 0 && released.code !== "timeout",
      released.code,
    );
    const previewAfter = cliJson(fromCli, ["output", "preview", hold.port], "output.preview");
    check("cli-hold-changed-nothing", previewAfter.preview_sha256 === hold.previewSha);

    // The successful update, now that nothing else holds the library.
    // Outlives the chained waits below (25 + 2 + 10 + 3 minutes) with margin.
    const watch = await watchProcesses(appPid, 50 * 60);
    try {
      await clickButton(browser, fromCopy.install, 120_000);
      event("install-clicked");
      await screenshot(browser, "06-installing");
      const exited = await waitUntil(
        async () => watch.events.find((entry) => entry.kind === "exited" && entry.pid === appPid),
        "from-version exit",
        25 * 60_000,
      );
      event("from-app-exited", exited);
      const installer = await waitUntil(
        async () =>
          watch.events.find(
            (entry) =>
              entry.kind === "started" && /(^|\s)\/UPDATE(\s|$)/u.test(entry.command_line ?? ""),
          ),
        "NSIS update installer",
        120_000,
      ).catch(() => null);
      report.installer_process = installer;
      check("nsis-update-installer-observed", installer !== null, installer);
      const installerPid = installer!.pid;
      const installerExit = await waitUntil(
        async () =>
          watch.events.find((entry) => entry.kind === "exited" && entry.pid === installerPid),
        "NSIS installer exit",
        10 * 60_000,
      );
      event("installer-exited", installerExit);
      check(
        "installer-arguments-passive-update",
        /(^|\s)\/P(\s|$)/u.test(installer!.command_line ?? ""),
        installer!.command_line,
      );
      const relaunch = await waitUntil(
        async () =>
          watch.events.find(
            (entry) =>
              entry.kind === "started" &&
              entry.pid !== appPid &&
              entry.path !== undefined &&
              entry.path !== null &&
              windowsPathKey(entry.path) === windowsPathKey(application),
          ),
        "automatic relaunch",
        3 * 60_000,
      ).catch(() => null);
      report.relaunch = relaunch
        ? { mode: "automatic", process: relaunch }
        : { mode: "none-observed" };
      event("relaunch", report.relaunch);
      if (relaunch) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        check("installer-relaunched-app", true, relaunch);
        check("relaunched-app-stays-running", processAlive(relaunch.pid), relaunch);
        report.relaunch_close = closeProcess(relaunch.pid);
      } else
        // The plugin asks NSIS to restart Portcove (`/R`), so no relaunch is a
        // failure. Later checks still run so the evidence stays complete.
        checkDeferred("installer-relaunched-app", false, {
          reason: "no new installed Portcove process within three minutes of the installer exit",
          installer_command_line: installer!.command_line,
        });
    } finally {
      await watch.stop();
    }
  } finally {
    await endSession(first, "from");
  }
  const markersAfterRelaunch = markerSnapshot();
  const appearedAfterRelaunch = appearedSince(markersIsolated, markersAfterRelaunch);
  report.default_locations_after_relaunch = {
    folders: folderSnapshot(),
    markers: markersAfterRelaunch,
  };
  report.default_locations_appeared_after_relaunch = appearedAfterRelaunch;
  // Only a relaunch that dropped its overrides creates these markers. That is
  // reported as this named failure, never silence.
  checkDeferred(
    "relaunch-kept-isolation-no-default-locations",
    appearedAfterRelaunch.length === 0,
    appearedAfterRelaunch,
  );
  const leftovers = installedApplicationProcesses();
  for (const row of leftovers)
    event("closing-leftover-app", { row, result: closeProcess(row.pid) });

  // 7. The installed version is the feed's version and nothing was lost.
  const toRegistration = uninstallEntries();
  report.to_registration = toRegistration;
  check(
    "registration-reports-new-version",
    toRegistration.length === 1 &&
      toRegistration[0]?.hive === "HKCU" &&
      toRegistration[0]?.display_version === toVersion,
    toRegistration,
  );
  const toRoot = registrationInstallRoot(toRegistration[0]);
  check("updated-registration-names-isolated-install-root", toRoot.matches, toRoot);
  const toExecutable = await hashFile(application);
  report.to_executable = { ...toExecutable, version: executableVersion(application) };
  check("installed-executable-replaced", toExecutable.sha256 !== fromExecutable.sha256);
  check(
    "update-preference-file-unchanged",
    (await hashFile(preferencesFile)).sha256 === preferenceHash,
  );
  const userAfterUpdate = await userManifest();
  check(
    "player-data-byte-identical-after-update",
    manifestDifferences(userBefore, userAfterUpdate).length === 0,
    manifestDifferences(userBefore, userAfterUpdate),
  );

  // 8. A fresh session on the updated installation.
  const toCopy = await releaseCopy(feed.offer.tag);
  const second = await startSession("to", tools);
  try {
    const browser = second.browser;
    const status = await updateStatus(browser);
    check("running-app-reports-new-version", status.current_version === toVersion, status);
    check("preference-survives-update", (await updatePreferences(browser)).channel === channel);
    await screenshot(browser, "07-to-started");
    await openInstalledUpdateSettings(browser);
    await assertPreviewSelected(browser, toCopy.preview);
    await clickButton(browser, toCopy.check);
    const checked = await waitUntil(
      async () => {
        const current = await updateStatus(browser);
        return !current.checking && current.last_checked_unix_seconds ? current : null;
      },
      "post-update check",
      180_000,
    );
    report.post_update_check = checked;
    check(
      "post-update-check-offers-nothing-older",
      checked.available === null || compareVersions(checked.available.version, toVersion) > 0,
      checked,
    );
    await screenshot(browser, "08-to-update-settings");
    await openLibrary(browser);
    await screenshot(browser, "09-to-library");
  } finally {
    await endSession(second, "to");
  }
  for (const row of installedApplicationProcesses())
    event("closing-leftover-app", { row, result: closeProcess(row.pid) });

  // 9. Library identity and player data after the updated app ran.
  const userFinal = await userManifest();
  check(
    "player-data-byte-identical-after-new-version-ran",
    manifestDifferences(userBefore, userFinal).length === 0,
    manifestDifferences(userBefore, userFinal),
  );
  const toAssets = windowsAssetNames(toVersion);
  const toSums = await releaseSums(feed.offer.tag);
  check(
    "feed-signature-matches-release-sig",
    toSums.get(`${toAssets.installer}.sig`) === feed.offer.signature_sha256,
  );
  report.to_release_installer = await download(feed.offer.tag, toAssets.installer, toSums);
  if (toSums.has(toAssets.cli)) {
    const toCli = await extractCli(
      (await download(feed.offer.tag, toAssets.cli, toSums)).file,
      toVersion,
    );
    const identityAfter = cliJson(toCli, ["library", "identity"], "library.identity");
    check("library-identity-unchanged", identityAfter.id === identityBefore.id, {
      before: identityBefore,
      after: identityAfter,
    });
  } else skip("library-identity-unchanged", `${feed.offer.tag} publishes no ${toAssets.cli}`);
  const markersAfter = markerSnapshot();
  const appeared = appearedSince(markersIsolated, markersAfter);
  report.default_locations_after = { folders: folderSnapshot(), markers: markersAfter };
  report.default_locations_appeared = appeared;
  checkDeferred("run-created-no-default-locations", appeared.length === 0, appeared);
  if (deferredFailures.length)
    throw new Error(`deferred checks failed: ${deferredFailures.join(", ")}`);
  report.versions = { from: fromVersion, to: toVersion };
}

async function retainDiagnostics() {
  for (const [name, source] of [
    ["diagnostics", path.join(scope.config, "diagnostics")],
    ["library-logs", path.join(scope.library, "logs")],
  ] as const) {
    if (!existsSync(source)) continue;
    await cp(source, path.join(output, name), { recursive: true }).catch((error: unknown) =>
      event("diagnostics-copy-failed", { name, error: errorMessage(error) }),
    );
  }
}

let exitCode = 0;
try {
  await main();
  report.outcome = "passed";
} catch (error) {
  exitCode = 1;
  report.outcome = "failed";
  report.error = errorMessage(error);
  console.error(error);
} finally {
  report.finished_at = new Date().toISOString();
  await retainDiagnostics().catch(() => undefined);
  try {
    restoreUserEnvironment();
  } catch (error) {
    report.relaunch_environment_restore_error = errorMessage(error);
  }
  persist();
  for (const row of (() => {
    try {
      return installedApplicationProcesses();
    } catch {
      return [];
    }
  })())
    closeProcess(row.pid);
}
process.exit(exitCode);
