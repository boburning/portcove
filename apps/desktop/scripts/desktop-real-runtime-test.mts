import { selectCatalogPort } from "./desktop-review-controls.mts";
import {
  parseRealRuntimeInput,
  runtimeMutable,
  absoluteRealRuntimeInputPath as absolute,
} from "../../../scripts/desktop-real-runtime-inputs.mts";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import path from "node:path";
import { copyFile, lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import type { WebDriver } from "selenium-webdriver";
import { By, Key, until } from "selenium-webdriver";
import { isRecord, errorMessage } from "../../../scripts/runtime-values.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import { ownedFixtureCommand } from "./desktop-scenario-state.mts";
import { transportValue, transportValues } from "./transport-values.mts";
import type { BoundaryInvoke } from "./desktop-main-webview-boundary.mts";
import type {
  nativeConfirmation,
  nativePreparedRuntimePicker,
} from "./desktop-native-confirmation.mts";
import { DatabaseSync } from "node:sqlite";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import {
  nativeSessionScript,
  readNativeSessionObservation,
} from "./desktop-owned-native-session.mts";
import type { NativeSessionMode } from "./desktop-owned-native-session.mts";
import type { NativeSessionObservations } from "./desktop-owned-native-session.mts";
import type { FixtureCommand } from "./desktop-scenario-state.mts";
import type { ExternalRuntimeRecord } from "../src/transport-types.generated.d.ts";

async function files(root: string): Promise<FileIdentity[]> {
  await noLinkedAncestors(root);
  assert.ok((await lstat(root)).isDirectory());
  const found: FileIdentity[] = [];
  let bytes = 0;
  let entries = 0;
  async function visit(directory: string, depth: number) {
    assert.ok(depth <= 64, "Runtime directory depth exceeds the pilot bound");
    for await (const entry of await opendir(directory)) {
      entries += 1;
      assert.ok(entries <= 10_000, "Runtime directory entry bound exceeded");
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      assert.ok(!metadata.isSymbolicLink(), "Real runtime inputs must not contain symbolic links");
      if (metadata.isDirectory()) await visit(file, depth + 1);
      else {
        assert.ok(metadata.isFile(), "Only regular runtime files are accepted");
        bytes += metadata.size;
        assert.ok(
          found.length < 10_000 && bytes <= 2 * 1024 ** 3,
          "Runtime input exceeds the bounded pilot inventory",
        );
        found.push(await fileIdentity(file));
      }
    }
  }
  await visit(root, 0);
  return found.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function noLinkedAncestors(file: string) {
  let current = absolute(file);
  for (;;) {
    assert.ok(
      !(await lstat(current)).isSymbolicLink(),
      "Pilot inputs must not traverse linked paths",
    );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function unchanged(identities: readonly FileIdentity[]) {
  for (const before of identities) {
    const after = await fileIdentity(before.path);
    assert.equal(after.bytes, before.bytes, before.path);
    assert.equal(after.sha256, before.sha256, before.path);
  }
}

export async function prepareRealRuntimeInputs({
  output,
  library,
  cli,
  manifest,
}: {
  output: string;
  library: string;
  cli: string;
  manifest: string;
}) {
  assert.equal(process.platform, "win32");
  assert.equal(
    process.env.PORTCOVE_QUALIFICATION_CATALOG,
    undefined,
    "Use normal catalog authority",
  );
  await noLinkedAncestors(manifest);
  const manifestStat = await lstat(manifest);
  assert.ok(manifestStat.isFile() && manifestStat.size <= 16 * 1024, "Bounded manifest required");
  const manifestIdentity = await fileIdentity(absolute(manifest));
  const decoded: unknown = JSON.parse(await readFile(manifest, "utf8"));
  const input = parseRealRuntimeInput(decoded);
  const command = ownedFixtureCommand({ cli, library, output });
  const packages = [];
  const sources: FileIdentity[] = [];
  const inputs: FileIdentity[] = [manifestIdentity];
  for (const request of input.packages) {
    const port = transportValue("port", command(["catalog", "show", request.port_id]));
    assert.equal(port.release.provider, "user-prepared");
    const spec = port.release.user_prepared?.["windows-x86-64"];
    assert.ok(spec && spec.executable && spec.mutable_paths?.length);
    assert.ok(port.source_profile && /^[a-z0-9-]+$/u.test(port.source_profile));
    assert.ok(
      spec.source_argument_extension && /^[a-z0-9]{1,8}$/u.test(spec.source_argument_extension),
    );
    await noLinkedAncestors(request.source);
    const sourceIdentity = await fileIdentity(request.source);
    const source = path.join(
      output,
      `real-runtime-${port.id}-owned-original.${spec.source_argument_extension}`,
    );
    await copyFile(request.source, source, constants.COPYFILE_EXCL);
    const sourceCopy = await fileIdentity(source);
    assert.equal(sourceCopy.sha256, sourceIdentity.sha256);
    assert.equal(sourceCopy.bytes, sourceIdentity.bytes);
    command(["source", "add", port.source_profile, source]);
    command(["source", "verify", port.source_profile]);
    sources.push(sourceIdentity, sourceCopy);
    inputs.push(sourceIdentity, sourceCopy);
    await noLinkedAncestors(request.archive);
    const archiveIdentity = await fileIdentity(request.archive);
    assert.equal(archiveIdentity.sha256, spec.archive_sha256);
    assert.equal(archiveIdentity.bytes, spec.archive_size);
    const originals = await files(request.directory);
    assert.ok(originals.length > 1);
    const directory = path.join(output, `real-prepared-runtime-${request.port_id}`);
    await mkdir(directory);
    for (const original of originals) {
      const relative = path.relative(request.directory, original.path);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      const destination = path.join(directory, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(original.path, destination, constants.COPYFILE_EXCL);
      const copied = await fileIdentity(destination);
      assert.equal(copied.sha256, original.sha256);
      assert.equal(copied.bytes, original.bytes);
      if (!runtimeMutable(relative, spec.mutable_paths)) inputs.push(copied);
    }
    await unchanged(originals);
    // Normal CLI/Core preview verifies the real copied tree and executable before
    // starting the Desktop. No injected definition or admission result is used.
    const preview = command(["external", "preview", port.id, directory]);
    inputs.push(archiveIdentity, ...originals);
    packages.push({
      port,
      spec,
      directory,
      originalDirectory: request.directory,
      originals,
      preview,
    });
  }
  return { packages, inputs, sources, manifestIdentity };
}

type RealFixture = Awaited<ReturnType<typeof prepareRealRuntimeInputs>>;
interface RealContext {
  browser: WebDriver;
  invoke: BoundaryInvoke;
  fixture: RealFixture;
  output: string;
  artifacts: string[];
  confirmNative: ReturnType<typeof nativeConfirmation>;
  selectPicker: ReturnType<typeof nativePreparedRuntimePicker>;
  restartApplication: (name: string) => Promise<WebDriver>;
  library: string;
  cli: string;
  application: string;
}

function success(value: unknown) {
  assert.ok(isRecord(value) && value.ok === true);
  return value.value;
}

export async function realRuntimeScenario(context: RealContext) {
  const report: Record<string, unknown> = {
    scope:
      "Two real prepared Windows runtimes through normal Desktop and Core contracts; owned copies only",
    routes: [],
  };
  try {
    await runRealRuntimeRoutes(context, report);
  } finally {
    const file = path.join(context.output, "real-runtime-desktop.json");
    await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
    context.artifacts.push(file);
  }
}

function samePath(left: string, right: string) {
  const normal = (value: string) =>
    path.resolve(value.startsWith("\\\\?\\") ? value.slice(4) : value).toLowerCase();
  return normal(left) === normal(right);
}

function sessionIds(library: string, portId: string) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    return database
      .prepare("SELECT id FROM launch_sessions WHERE port_id = ? ORDER BY started_at, id")
      .all(portId)
      .map((row) => {
        assert.ok(typeof row.id === "string");
        return row.id;
      });
  } finally {
    database.close();
  }
}

async function runRealRuntimeRoutes(context: RealContext, report: Record<string, unknown>) {
  let browser = context.browser;
  const {
    fixture,
    output,
    artifacts,
    invoke,
    confirmNative,
    selectPicker,
    library,
    cli,
    application,
  } = context;
  const command = ownedFixtureCommand({ cli, library, output });
  const routes: Record<string, unknown>[] = [];
  report.routes = routes;
  const appIdentity = await fileIdentity(application);
  report.application = appIdentity;
  function native<Mode extends NativeSessionMode>(
    mode: Mode,
    snapshot: string,
    extra: string[] = [],
  ) {
    const result = spawnCommand(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        nativeSessionScript,
        "-Mode",
        mode,
        "-SnapshotPath",
        snapshot,
        ...extra,
      ],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const decoded: unknown = JSON.parse(result.stdout);
    return readNativeSessionObservation(mode, decoded);
  }
  async function screenshot(name: string) {
    const file = path.join(output, `${name}.png`);
    await writeFile(file, Buffer.from(await browser.takeScreenshot(), "base64"), { flag: "wx" });
    artifacts.push(file);
  }
  const button = (name: string) => By.xpath(`//button[normalize-space(.)="${name}"]`);
  async function open(port: { id: string; name: string }) {
    await browser.findElement(By.xpath('//nav//button[contains(., "Discover")]')).click();
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, port.name);
    await selectCatalogPort(browser, port.id);
  }
  async function status(portId: string) {
    const statuses = transportValues("status", success(await invoke("get_statuses")));
    const selected = statuses.filter((entry) => entry.port_id === portId);
    assert.equal(selected.length, 1);
    const current = selected[0];
    assert.ok(current);
    assert.equal(current.active, null);
    return current;
  }
  async function review(kind: string, action: string) {
    const selector = By.css(`[role="dialog"][aria-describedby="external-${kind}-description"]`);
    return browser.wait(async () => {
      const matches = await browser.findElements(selector);
      assert.ok(matches.length <= 1);
      const dialog = matches[0];
      if (!dialog || !(await dialog.isDisplayed())) return false;
      const controls = await dialog.findElements(
        By.xpath(`.//button[normalize-space(.)="${action}"]`),
      );
      assert.ok(controls.length <= 1, "External review action must be unique");
      const control = controls[0];
      if (!control || !(await control.isDisplayed()) || !(await control.isEnabled())) return false;
      return { dialog, control };
    }, 15_000);
  }
  for (const item of fixture.packages) {
    const { port, spec, directory } = item;
    const route: Record<string, unknown> = {
      port_id: port.id,
      version: spec.version,
      directory,
      steps: [],
    };
    routes.push(route);
    await open(port);
    await browser.wait(until.elementLocated(button("Choose game folder")), 15_000);
    const instructions = await browser.findElement(By.css("main")).getText();
    assert.ok(
      instructions.includes(spec.archive_name) &&
        instructions.includes(spec.version) &&
        instructions.includes(spec.executable),
    );
    assert.ok(instructions.includes("It does not copy, update, back up, or delete these files."));
    await screenshot(`${port.id}-manual-return`);
    const choose = async (name: string) => {
      await browser.findElement(button("Choose game folder")).click();
      const selected: unknown = await selectPicker(`${port.id}-${name}`, directory);
      assert.ok(
        isRecord(selected) && selected.selected === true && selected.supplied_directory === true,
      );
      const current = await review("register", "Use this installation");
      assert.ok(current);
      const text = await current.dialog.getText();
      assert.ok(text.includes(spec.version) && text.includes(spec.executable));
      return current;
    };
    let current = await choose("dismiss");
    await current.dialog.findElement(By.xpath('.//button[normalize-space(.)="Cancel"]')).click();
    await browser.wait(async () => !(await status(port.id)).external_runtime, 15_000);
    current = await choose("register");
    await screenshot(`${port.id}-registration-review`);
    await current.control.click();
    await confirmNative(
      "Confirm external runtime",
      "Register runtime",
      port.id,
      `${port.id}-registration-consent`,
    );
    const registered = await browser.wait(
      async () => (await status(port.id)).external_runtime || false,
      15_000,
    );
    assert.ok(registered);
    assert.equal(registered.version, spec.version);
    assert.equal(registered.immutable_tree_sha256, spec.immutable_tree_sha256);
    assert.ok(samePath(registered.path, directory));
    route.registered = registered;
    // Read-only Core revalidation, through the real adapter, repeats no registration.
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    route.revalidated_preview = success(
      await invoke("preview_external_runtime", {
        portId: port.id,
        path: directory,
        generation: bootstrap.generation,
      }),
    );
    browser = await context.restartApplication(`${port.id}-registered`);
    await open(port);
    assert.deepEqual((await status(port.id)).external_runtime, registered);
    await screenshot(`${port.id}-restart-readback`);
    await launchRealRuntime(
      { ...context, browser },
      item,
      registered,
      route,
      command,
      native,
      screenshot,
      appIdentity,
    );
    const postgame = await files(directory);
    route.postgame = postgame;
    await browser.findElement(button("Stop using this installation")).click();
    const removal = await review("remove", "Stop using this installation");
    assert.ok(removal);
    await screenshot(`${port.id}-removal-review`);
    await removal.control.click();
    await confirmNative(
      "Confirm registration removal",
      "Remove registration",
      port.id,
      `${port.id}-removal-consent`,
    );
    await browser.wait(async () => !(await status(port.id)).external_runtime, 15_000);
    assert.deepEqual(await files(directory), postgame);
    assert.deepEqual(await files(item.originalDirectory), item.originals);
    await unchanged(fixture.sources);
    assert.deepEqual(sessionIds(library, port.id), route.session_ids_after_launch);
    await screenshot(`${port.id}-registration-only-removal`);
    route.removed = await status(port.id);
  }
}

type NativeObserve = <Mode extends NativeSessionMode>(
  mode: Mode,
  snapshot: string,
  extra?: string[],
) => NativeSessionObservations[Mode];

async function launchRealRuntime(
  context: RealContext,
  item: RealFixture["packages"][number],
  registration: ExternalRuntimeRecord,
  route: Record<string, unknown>,
  command: FixtureCommand,
  native: NativeObserve,
  screenshot: (name: string) => Promise<void>,
  appIdentity: FileIdentity,
) {
  const { browser, library, output, artifacts, application } = context;
  const { port, spec, directory } = item;
  const directories = spec.mutable_paths.filter(
    (entry) => entry === "saves" || entry === ".runtime",
  );
  assert.equal(directories.length, 1, "Selected route must declare one mutable save directory");
  const prefix = directories[0];
  const sentinelRelative = `${prefix}/portcove-owned-preservation-sentinel.bin`;
  assert.ok(runtimeMutable(sentinelRelative, spec.mutable_paths));
  const sentinel = path.join(directory, sentinelRelative);
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "Owned external preservation witness.\n", { flag: "wx" });
  const sentinelIdentity = await fileIdentity(sentinel);
  const pregame = await files(directory);
  route.pregame = pregame;
  const previous = new Set(sessionIds(library, port.id));
  const previousActivities = new Set(
    transportValue("activity", command(["activity"])).records.map((entry) => entry.id),
  );
  const executable = path.join(directory, spec.executable);
  const executableIdentity = await fileIdentity(executable);
  const earliest = Date.now();
  const play = By.xpath('//button[normalize-space(.)="Play"]');
  const control = await browser.wait(async () => {
    const candidates = await browser.findElements(play);
    const displayed = [];
    for (const button of candidates)
      if ((await button.isDisplayed()) && (await button.isEnabled())) displayed.push(button);
    assert.ok(displayed.length <= 1);
    return displayed[0] || false;
  }, 15_000);
  assert.ok(control);
  await control.click();
  let cleanupSnapshot: string | undefined;
  let naturalExit = false;
  let primaryFailure: { error: unknown } | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    const session = await browser.wait(async () => {
      const fresh = sessionIds(library, port.id).filter((id) => !previous.has(id));
      assert.ok(fresh.length <= 1, "One Play decision must not duplicate launch sessions");
      if (!fresh[0]) return false;
      const current = transportValue("launch_request", command(["launch", "show", fresh[0]]));
      assert.ok(current);
      route.observed_session = current;
      assert.equal(current.port_id, port.id);
      assert.equal(current.owner_kind, "external");
      assert.equal(current.install_id, registration.id);
      assert.ok(samePath(current.install_root, directory));
      assert.equal(
        current.outcome,
        null,
        "Retain early terminal results; do not broaden process matching",
      );
      return current.phase === "running" &&
        current.child_pid &&
        current.child_identity &&
        current.supervisor_identity
        ? current
        : false;
    }, 30_000);
    assert.ok(
      session && session.child_pid && session.child_identity && session.supervisor_identity,
    );
    const supervisorFile = path.join(output, `${port.id}-supervisor-identity.json`);
    const supervisor = native("SnapshotDriver", supervisorFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
    ]);
    artifacts.push(supervisorFile);
    assert.ok(samePath(supervisor.driver.path, application));
    assert.equal(
      `windows-filetime:${supervisor.driver.started_filetime}`,
      session.supervisor_identity,
    );
    const currentApp = await fileIdentity(supervisor.driver.path);
    assert.equal(currentApp.sha256, appIdentity.sha256);
    assert.equal(currentApp.bytes, appIdentity.bytes);
    const unixMilliseconds = (ticks: string) =>
      Number((BigInt(ticks) - 116444736000000000n) / 10000n);
    assert.ok(unixMilliseconds(supervisor.driver.started_filetime) >= earliest - 1000);
    const candidateCleanup = path.join(output, `${port.id}-game-cleanup-identity.json`);
    const game = native("SnapshotApplication", candidateCleanup, [
      "-DriverProcessId",
      String(session.child_pid),
      "-ExpectedParentProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      executable,
      "-ExpectedApplicationSha256",
      executableIdentity.sha256,
    ]);
    artifacts.push(candidateCleanup);
    assert.equal(`windows-filetime:${game.driver.started_filetime}`, session.child_identity);
    assert.ok(samePath(game.driver.path, executable));
    assert.ok(unixMilliseconds(game.driver.started_filetime) >= earliest - 1000);
    cleanupSnapshot = candidateCleanup;
    const closeFile = path.join(output, `${port.id}-game-close-identity.json`);
    const close = native("Snapshot", closeFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      executable,
    ]);
    artifacts.push(closeFile);
    assert.deepEqual(close.driver, supervisor.driver);
    const root = close.processes.filter((entry) => entry.pid === session.child_pid);
    assert.equal(root.length, 1);
    assert.deepEqual(root[0], game.driver);
    assert.equal(close.application_pid, session.child_pid);
    route.live_game = { executableIdentity, supervisor, game, close };
    await screenshot(`${port.id}-desktop-launch-observation`);
    const requested = native("RequestClose", closeFile, ["-ApplicationPath", executable]);
    route.ordinary_game_close = { requested };
    const requestFile = path.join(output, `${port.id}-ordinary-close-request.json`);
    await writeFile(requestFile, JSON.stringify(requested, null, 2), { flag: "wx" });
    artifacts.push(requestFile);
    const exited = native("Wait", closeFile);
    naturalExit = true;
    route.ordinary_game_close = { requested, exited };
    const terminal = await browser.wait(() => {
      const current = transportValue("launch_request", command(["launch", "show", session.id]));
      return current?.outcome !== null && current?.finished_at ? current : false;
    }, 30_000);
    assert.ok(terminal);
    const supervisorExitFile = path.join(output, `${port.id}-supervisor-exit-identity.json`);
    // Read-only exit observation, derived only from the independently verified
    // live supervisor identity. This inventory is never used to signal a process.
    await writeFile(
      supervisorExitFile,
      JSON.stringify(
        {
          ...supervisor,
          source_snapshot: supervisorFile,
          derivation: "verified-supervisor-only-exit-observation",
          processes: [supervisor.driver],
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    artifacts.push(supervisorExitFile);
    const supervisorExited = native("Wait", supervisorExitFile);
    assert.equal(supervisorExited.observed_processes, 1);
    route.natural_supervisor_exit = supervisorExited;
    route.terminal_session = terminal;
    assert.equal(terminal.outcome, "succeeded");
    assert.equal(terminal.exit_code, 0);
    const newActivities = transportValue("activity", command(["activity"])).records.filter(
      (entry) =>
        !previousActivities.has(entry.id) &&
        entry.operation === "launch" &&
        entry.target_id === port.id,
    );
    assert.equal(newActivities.length, 1);
    assert.equal(newActivities[0]?.status, "succeeded");
    route.launch_activity = newActivities;
    const afterIds = sessionIds(library, port.id);
    route.session_ids_after_launch = afterIds;
    assert.deepEqual(afterIds.toSorted(), [...previous, session.id].sort());
    const after = await files(directory);
    const immutable = (inventory: FileIdentity[]) =>
      inventory
        .filter((file) => !runtimeMutable(path.relative(directory, file.path), spec.mutable_paths))
        .map((file) => [path.relative(directory, file.path), file.bytes, file.sha256]);
    assert.deepEqual(immutable(after), immutable(pregame));
    await unchanged([sentinelIdentity, ...context.fixture.sources, ...item.originals]);
    assert.deepEqual(await files(item.originalDirectory), item.originals);
    route.postgame_verified = after;
  } catch (error) {
    primaryFailure = { error };
    route.failure = errorMessage(error);
  } finally {
    if (cleanupSnapshot && !naturalExit) {
      const cleanup: Record<string, unknown> = {};
      route.failure_only_game_cleanup = cleanup;
      try {
        cleanup.stopped = native("StopApplication", cleanupSnapshot, [
          "-ApplicationPath",
          executable,
        ]);
      } catch (error) {
        cleanup.stop_error = errorMessage(error);
        cleanupErrors.push(error);
      }
      try {
        cleanup.exited = native("Wait", cleanupSnapshot);
      } catch (error) {
        cleanup.wait_error = errorMessage(error);
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length) {
        route.cleanup_uncertain = true;
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure.error] : []), ...cleanupErrors],
      "Real runtime journey failed and owned game cleanup could not be established",
    );
  if (primaryFailure) throw primaryFailure.error;
}
