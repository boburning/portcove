import assert from "node:assert/strict";
import path from "node:path";
import {
  cp,
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { By, Key, until, type WebDriver } from "selenium-webdriver";
import type { FileIdentity } from "../../../scripts/development-evidence.mts";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { spawnCommand } from "../../../scripts/dev-storage.mts";
import { errorMessage, errorCode } from "../../../scripts/runtime-values.mts";
import type { ScenarioInvoke } from "./desktop-scenario-context.mts";
import type {
  nativeConfirmation,
  nativePreparedRuntimePicker,
} from "./desktop-native-confirmation.mts";
import type { PreparationContext } from "./desktop-preparation-test.mts";
import type { NativeSessionMode } from "./desktop-owned-native-session.mts";
import {
  nativeSessionScript,
  ownedGameWindowScript,
  sopwithKnownFolderScript,
  readNativeSessionObservation,
} from "./desktop-owned-native-session.mts";
import { fixtureSuccess as success } from "./desktop-scenario-state.mts";
import { transportValue } from "./transport-values.mts";
import { executeBrowserScript } from "./browser-script.mts";
import { reviewControls, selectPrimaryNavigation } from "./desktop-review-controls.mts";
import { createImageRefusal, defaultCoverScenario } from "./desktop-default-cover-test.mts";

interface InstalledContext {
  browser: WebDriver;
  invoke: ScenarioInvoke;
  output: string;
  library: string;
  application: string;
  artifacts: string[];
  confirmNative: ReturnType<typeof nativeConfirmation>;
  selectPicker: ReturnType<typeof nativePreparedRuntimePicker>;
  restart: PreparationContext["restartApplication"];
  capture: (name: string, force?: boolean) => Promise<unknown>;
  setTheme: (theme: "light" | "dark") => Promise<unknown>;
}

const portId = "fragglet-sdl-sopwith";
const packageDigest = "b664b5fac5feac3f3a23b7082909d9280a95ae40cc7f8daeff089b191bcc746c";
const gameDigest = "0930401eccd11ec04c1db726042470da547bd90bf8d267d129a6e48db22c40b6";

function windowsPath(value: string) {
  const ordinary = value.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, "");
  assert.ok(
    path.win32.isAbsolute(ordinary) && /^[A-Za-z]:\\/u.test(ordinary),
    "Owned local Windows path required",
  );
  return path.win32.normalize(ordinary);
}
function sameWindowsPath(left: string, right: string) {
  return windowsPath(left).toLowerCase() === windowsPath(right).toLowerCase();
}

// Read-only observation of the real application's durable launch state. The
// application itself neither shells out to a CLI nor uses a fixture catalog.
function launchRows(library: string) {
  const database = new DatabaseSync(path.join(library, "portcove.sqlite3"), { readOnly: true });
  try {
    return database
      .prepare("SELECT * FROM launch_sessions WHERE port_id = ? ORDER BY started_at,id")
      .all(portId)
      .map((row) => transportValue("launch_request", row));
  } finally {
    database.close();
  }
}

async function knownFolder() {
  const result = spawnCommand("pwsh", ["-NoProfile", "-File", sopwithKnownFolderScript], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as { exists: boolean; path: string; files: unknown[] };
}

async function tree(root: string): Promise<FileIdentity[]> {
  const files: FileIdentity[] = [];
  let entries = 0,
    bytes = 0;
  async function visit(directory: string, depth: number) {
    assert.ok(depth <= 24);
    for await (const entry of await opendir(directory)) {
      assert.ok(++entries <= 2_000);
      const name = path.join(directory, entry.name),
        stat = await lstat(name);
      assert.ok(!stat.isSymbolicLink(), "Owned upstream tree must not contain links");
      if (stat.isDirectory()) await visit(name, depth + 1);
      else {
        assert.ok(stat.isFile());
        bytes += stat.size;
        assert.ok(bytes <= 128 * 1024 * 1024);
        files.push(await fileIdentity(name));
      }
    }
  }
  await visit(root, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function installedOnboardingScenario(context: InstalledContext) {
  let browser = context.browser;
  const { invoke, output, application, artifacts, confirmNative, selectPicker, restart, capture } =
    context;
  const report: Record<string, unknown> = {
    scope:
      "Ordinary installed Windows Tauri/Core IPC, real official SDL Sopwith portable package; startup and registration only, no original-game setup, gameplay, save/load or physical-input claim",
    application: await fileIdentity(application),
    steps: [],
  };
  const steps = report.steps as string[];
  const button = (name: string) => By.xpath(`//button[normalize-space(.)="${name}"]`);
  const click = async (name: string) => reviewControls(browser).click(button(name));
  const snapshot = async () => {
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    return transportValue(
      "desktop_workspace_snapshot",
      success(await invoke("get_workspace_snapshot", { generation: bootstrap.generation })),
    );
  };
  const status = async () => {
    const matches =
      (await snapshot()).listing_statuses?.filter((row) => row.port_id === portId) ?? [];
    assert.equal(matches.length, 1);
    return { ...matches[0]!.status, listing_actions: matches[0]!.actions };
  };
  const open = async (
    id: string,
    query: string,
    workspace: "Find games" | "Library" = "Find games",
  ) => {
    await selectPrimaryNavigation(browser, workspace);
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, query);
    await reviewControls(browser).click(
      By.css(
        `[data-detail-origin="${workspace === "Find games" ? "catalog" : "library"}:card:${id}"]`,
      ),
    );
    await browser.wait(until.elementLocated(By.css(`[data-detail-port-id="${id}"]`)), 15_000);
  };
  try {
    const initialKnownFolder = await knownFolder();
    assert.equal(
      initialKnownFolder.exists,
      false,
      "Disposable upstream known-folder subtree must be absent before launch; preserve any existing personal state",
    );
    report.known_folder_before = initialKnownFolder;
    const initial = await snapshot();
    assert.ok(initial.listing_catalog && initial.listing_catalog.listings.length >= 522);
    assert.equal(
      initial.catalog.ports.some((port) => port.id === portId),
      false,
    );
    const listing = initial.listing_catalog.listings.find((port) => port.id === portId);
    assert.ok(listing);
    report.initial_catalog = {
      visible: initial.listing_catalog.listings.length,
      strict: initial.catalog.ports.length,
      representative: listing,
    };
    await installedCovers({ ...context, browser }, report);
    browser = await restart("installed-onboarding-online");
    await open(portId, listing.name);
    await capture("installed-sopwith-availability", true);
    steps.push("listing-only availability and setup information inspected");
    await click("Check upstream downloads");
    const asset = By.xpath('//*[@role="option" and contains(.,"sopwith-2.9.0-win64.zip")]');
    const choice = await browser.wait(until.elementLocated(By.css('[role="combobox"]')), 30_000);
    await choice.click();
    await reviewControls(browser).click(asset);
    const downloads = path.join(output, "upstream-downloads");
    await mkdir(downloads);
    await click("Choose download folder…");
    await selectPicker("installed-upstream-destination", downloads);
    await click("Review download");
    await browser.wait(until.elementLocated(By.css('[role="dialog"]')), 15_000);
    await browser.wait(async () => {
      const dialogs = await browser.findElements(By.css('[role="dialog"]'));
      return (
        dialogs.length === 1 && (await dialogs[0]!.getText()).includes("sopwith-2.9.0-win64.zip")
      );
    }, 15_000);
    await capture("installed-sopwith-download-review", true);
    await click("Download");
    const pending = await browser.wait(async () => {
      const matches =
        (await snapshot()).pending_setups?.filter((row) => row.port_id === portId) ?? [];
      assert.ok(matches.length <= 1);
      return matches[0]?.state === "downloaded" ? matches[0] : false;
    }, 120_000);
    assert.ok(pending);
    assert.equal(pending.archive_sha256, packageDigest);
    assert.equal(pending.artifact.release_id, 268043256);
    assert.equal(pending.artifact.asset_id, 325276947);
    assert.equal(pending.artifact.size, 1142869);
    const pendingDirectory = windowsPath(pending.path);
    const relative = path.relative(windowsPath(downloads), pendingDirectory);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const executable = path.join(pendingDirectory, "sopwith.exe");
    assert.equal((await fileIdentity(executable)).sha256, gameDigest);
    report.download = pending;
    browser = await restart("installed-pending-setup");
    await open(portId, listing.name);
    assert.deepEqual(
      (await snapshot()).pending_setups?.find((row) => row.port_id === portId),
      pending,
    );
    await browser.wait(until.elementLocated(button("Continue setup")), 15_000);
    await capture("installed-sopwith-pending-after-restart", true);
    steps.push(
      "upstream package downloaded and safely extracted; pending setup survived full application restart",
    );
    await click("Continue setup");
    await click("Choose game executable…");
    await confirmNative(
      "Locate game executable",
      "Open",
      "File name:",
      "installed-sopwith-executable",
      executable,
    );
    const cwd = await browser.findElement(By.css('input[aria-label="Working directory"]'));
    await cwd.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, pendingDirectory);
    await reviewControls(browser).click(
      By.xpath('//summary[normalize-space(.)="Advanced launch options"]'),
    );
    await browser.findElement(By.css('textarea[aria-label="Launch arguments"]')).sendKeys("-n\n-q");
    await click("Review launch details");
    await capture("installed-sopwith-registration-review", true);
    await click("Use this installation");
    await confirmNative(
      "Use your existing installation",
      "Use installation",
      executable,
      "installed-sopwith-registration-consent",
    );
    const registered = await browser.wait(
      async () => (await status()).external_runtime || false,
      15_000,
    );
    assert.ok(registered);
    assert.deepEqual(registered.user_selected?.arguments, ["-n", "-q"]);
    report.registered = registered;
    browser = await restart("installed-registered");
    assert.deepEqual((await status()).external_runtime, registered);
    await open(portId, listing.name, "Library");
    await launchInstalledGame({ ...context, browser }, executable, registered.id, "first", report);
    steps.push(
      "registered actual executable/cwd/literal arguments via native consent; Library launch showed the real game and terminated normally",
    );
    browser = await restart("installed-before-relink");
    await open(portId, listing.name, "Library");
    const replacement = path.join(output, "sopwith-relinked-runtime");
    await cp(pendingDirectory, replacement, { recursive: true, errorOnExist: true, force: false });
    await click("Edit launch details…");
    await click("Choose game executable…");
    await confirmNative(
      "Locate game executable",
      "Open",
      "File name:",
      "installed-sopwith-relink-picker",
      path.join(replacement, "sopwith.exe"),
    );
    await click("Review launch details");
    await capture("installed-sopwith-relink-review", true);
    await click("Save launch details");
    await confirmNative(
      "Change launch details",
      "Change launch details",
      replacement,
      "installed-sopwith-relink-consent",
    );
    const relinked = await browser.wait(async () => {
      const current = (await status()).external_runtime;
      return current && sameWindowsPath(current.path, replacement) ? current : false;
    }, 15_000);
    assert.ok(relinked);
    assert.deepEqual(relinked.user_selected?.arguments, ["-n", "-q"]);
    assert.equal(relinked.id, registered.id, "Reviewed relink preserves the registration identity");
    report.relinked = relinked;
    await launchInstalledGame(
      { ...context, browser },
      path.join(replacement, "sopwith.exe"),
      relinked.id,
      "relinked",
      report,
    );
    const beforeOriginal = await tree(pending.path),
      beforeReplacement = await tree(replacement);
    const beforeKnownFolder = await knownFolder();
    report.known_folder_postgame = beforeKnownFolder;
    await click("Remove registration");
    await capture("installed-sopwith-remove-review", true);
    await reviewControls(browser).click(
      By.xpath('//div[@role="dialog"]//button[normalize-space(.)="Stop using this installation"]'),
    );
    await confirmNative(
      "Confirm registration removal",
      "Remove registration",
      portId,
      "installed-sopwith-removal-consent",
    );
    await browser.wait(async () => !(await status()).external_runtime, 15_000);
    await open(portId, listing.name);
    if ((await snapshot()).pending_setups?.some((row) => row.port_id === portId)) {
      await click("Remove setup entry…");
      await click("Remove setup entry");
    }
    const final = await snapshot();
    assert.ok(!final.pending_setups?.some((row) => row.port_id === portId));
    assert.ok(!(await status()).external_runtime);
    assert.equal(
      (await status()).listing_actions.find((action) => action.action === "launch")?.allowed,
      false,
    );
    assert.deepEqual(await tree(pending.path), beforeOriginal);
    assert.deepEqual(await tree(replacement), beforeReplacement);
    assert.deepEqual(
      await knownFolder(),
      beforeKnownFolder,
      "Registration/setup removal must preserve actual upstream known-folder state",
    );
    report.external_trees_preserved = { original: beforeOriginal, relinked: beforeReplacement };
    report.final_status = await status();
    await capture("installed-sopwith-bookkeeping-removed", true);
    steps.push(
      "registration survived restart; reviewed relink launched again; registration and setup bookkeeping removed with both external trees unchanged",
    );
  } catch (error) {
    report.failure = errorMessage(error);
    throw error;
  } finally {
    const file = path.join(output, "installed-onboarding-and-covers.json");
    await writeFile(file, JSON.stringify(report, null, 2), { flag: "wx" });
    artifacts.push(file);
  }
}

async function launchInstalledGame(
  context: InstalledContext,
  executable: string,
  registrationId: string,
  label: string,
  report: Record<string, unknown>,
) {
  const { browser, library, output, application, artifacts } = context;
  const previous = new Set(launchRows(library).map((row) => row!.id)),
    earliest = Date.now();
  const executableIdentity = await fileIdentity(executable);
  assert.equal(executableIdentity.sha256, gameDigest);
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
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return readNativeSessionObservation(mode, JSON.parse(result.stdout));
  }
  await reviewControls(browser).click(By.xpath('//button[normalize-space(.)="Play"]'));
  let gameSnapshot: string | undefined,
    exited = false;
  const observed: Record<string, unknown> = {};
  report[`${label}_launch`] = observed;
  try {
    const session = await browser.wait(() => {
      const fresh = launchRows(library).filter((row) => !previous.has(row!.id));
      assert.ok(fresh.length <= 1);
      const row = fresh[0];
      if (!row) return false;
      assert.equal(row.outcome, null);
      return row.phase === "running" &&
        row.child_identity &&
        row.child_pid &&
        row.supervisor_identity
        ? row
        : false;
    }, 30_000);
    assert.ok(session && session.child_pid);
    assert.equal(session.owner_kind, "external");
    assert.equal(session.install_id, registrationId);
    observed.session = session;
    const supervisorFile = path.join(output, `${label}-supervisor.json`);
    const supervisor = native("SnapshotDriver", supervisorFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
    ]);
    artifacts.push(supervisorFile);
    assert.equal(
      path.resolve(supervisor.driver.path).toLowerCase(),
      path.resolve(application).toLowerCase(),
    );
    assert.equal(
      `windows-filetime:${supervisor.driver.started_filetime}`,
      session.supervisor_identity,
    );
    assert.equal(
      (await fileIdentity(supervisor.driver.path)).sha256,
      (await fileIdentity(application)).sha256,
    );
    assert.ok(
      Number((BigInt(supervisor.driver.started_filetime) - 116444736000000000n) / 10000n) >=
        earliest - 1000,
    );
    const identityFile = path.join(output, `${label}-game-identity.json`);
    const game = native("SnapshotApplication", identityFile, [
      "-DriverProcessId",
      String(session.child_pid),
      "-ExpectedParentProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      executable,
      "-ExpectedApplicationSha256",
      gameDigest,
    ]);
    artifacts.push(identityFile);
    gameSnapshot = identityFile;
    assert.equal(`windows-filetime:${game.driver.started_filetime}`, session.child_identity);
    const closeFile = path.join(output, `${label}-game-close.json`);
    const close = native("Snapshot", closeFile, [
      "-DriverProcessId",
      String(session.supervisor_pid),
      "-ApplicationPath",
      executable,
    ]);
    artifacts.push(closeFile);
    assert.equal(close.application_pid, session.child_pid);
    assert.deepEqual(close.driver, supervisor.driver);
    const screenshot = path.join(output, `${label}-actual-sopwith-window.png`),
      windowEvidence = path.join(output, `${label}-actual-sopwith-window.json`);
    const capture = spawnCommand(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        ownedGameWindowScript,
        "-SnapshotPath",
        closeFile,
        "-ApplicationPath",
        executable,
        "-ApplicationSha256",
        gameDigest,
        "-ScreenshotPath",
        screenshot,
        "-ObservationPath",
        windowEvidence,
        "-ReadySeconds",
        "15",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    artifacts.push(screenshot, windowEvidence);
    observed.visible_window = JSON.parse(capture.stdout);
    observed.close = native("RequestClose", closeFile, ["-ApplicationPath", executable]);
    observed.game_exit = native("Wait", closeFile);
    exited = true;
    const terminal = await browser.wait(
      () =>
        launchRows(library).find(
          (row) => row!.id === session.id && row!.outcome !== null && row!.finished_at,
        ) || false,
      30_000,
    );
    assert.ok(terminal);
    assert.equal(terminal.outcome, "succeeded");
    assert.equal(terminal.exit_code, 0);
    observed.terminal = terminal;
    const supervisorExit = path.join(output, `${label}-supervisor-exit.json`);
    await writeFile(
      supervisorExit,
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
    artifacts.push(supervisorExit);
    observed.supervisor_exit = native("Wait", supervisorExit);
  } finally {
    if (gameSnapshot && !exited) {
      observed.failure_cleanup = native("StopApplication", gameSnapshot, [
        "-ApplicationPath",
        executable,
      ]);
      observed.failure_exit = native("Wait", gameSnapshot);
    }
  }
}

async function installedCovers(context: InstalledContext, report: Record<string, unknown>) {
  // The actual client has no maintainer credential or provider search endpoint.
  for (const name of Object.keys(process.env))
    assert.ok(
      !/^(IGDB|TWITCH).*(SECRET|TOKEN|CLIENT_ID)$/i.test(name),
      "Player test must not inherit maintainer provider credentials",
    );
  let browser = context.browser;
  const refusal = await createImageRefusal();
  try {
    const cache = path.join(context.library, "artwork-cache");
    assert.deepEqual(
      await readdir(cache).catch((error) => {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }),
      [],
    );
    browser = await context.restart("installed-first-ever-offline", undefined, refusal.environment);
    await selectPrimaryNavigation(browser, "Find games");
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, "Ship of Harkinian");
    await reviewControls(browser).click(By.css('[data-detail-origin="catalog:card:shipwright"]'));
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          () =>
            document.querySelector<HTMLElement>(".detail-cover")?.dataset.artworkSource ===
            "generated_fallback",
        ),
      15_000,
    );
    await browser.wait(() => refusal.origins.includes("images.igdb.com"), 15_000);
    await context.capture("installed-first-ever-offline-fallback", true);
    report.first_offline = {
      empty_cache: true,
      refused_origins: refusal.origins,
      stable_fallback: true,
      controlled_failure: true,
    };
    await selectPrimaryNavigation(browser, "Library");
  } finally {
    await refusal.close();
  }
  browser = await context.restart("installed-cold-online");
  await defaultCoverScenario({
    ...context,
    browser,
    cacheConditions: true,
    selectedIds: [
      "shipwright",
      "dkr-r",
      "super-mario-bros-remastered",
      "corsixth-corsixth",
      "the-force-engine-dark-forces",
      "vcmi-vcmi",
    ],
    scenario: async (_id, action) => {
      await action();
    },
  });
  browser = await context.restart("installed-local-choice-online");
  await installedArtworkChoice({ ...context, browser }, report);
  browser = await context.restart("installed-authored-fallback");
  const bootstrap = transportValue(
    "desktop_bootstrap_status",
    success(await context.invoke("get_bootstrap_status")),
  );
  const workspace = transportValue(
    "desktop_workspace_snapshot",
    success(await context.invoke("get_workspace_snapshot", { generation: bootstrap.generation })),
  );
  const fallback = workspace.listing_catalog?.listings.find((listing) => !listing.artwork);
  assert.ok(fallback, "The live catalog retains honest unresolved-cover entries");
  await selectPrimaryNavigation(browser, "Find games");
  const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
  await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, fallback.name);
  await reviewControls(browser).click(By.css(`[data-detail-origin="catalog:card:${fallback.id}"]`));
  await browser.wait(
    () =>
      executeBrowserScript(
        browser,
        () =>
          document.querySelector<HTMLElement>(".detail-cover")?.dataset.artworkSource ===
          "generated_fallback",
      ),
    15_000,
  );
  await context.capture("installed-authored-missing-cover", true);
  report.authored_fallback = { id: fallback.id, title: fallback.name, declared_mapping: null };
  report.account_free_covers =
    "default-cover-cache-conditions.json; actual selected listing/integration covers, empty-cache online and cached offline restart; no player authentication/search";
}

async function installedArtworkChoice(context: InstalledContext, report: Record<string, unknown>) {
  const { invoke, output, library, confirmNative, restart, capture } = context;
  let browser = context.browser;
  const id = "corsixth-corsixth";
  const control = (label: string) =>
    By.xpath(`//section[@aria-label="Cover image"]//button[normalize-space(.)="${label}"]`);
  const state = async () => {
    const bootstrap = transportValue(
      "desktop_bootstrap_status",
      success(await invoke("get_bootstrap_status")),
    );
    return transportValue(
      "artwork_state",
      success(
        await invoke("get_artwork", {
          portId: id,
          slot: "cover",
          generation: bootstrap.generation,
        }),
      ),
    );
  };
  const open = async () => {
    await selectPrimaryNavigation(browser, "Find games");
    const search = await browser.wait(until.elementLocated(By.id("port-search")), 15_000);
    await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, "CorsixTH");
    await reviewControls(browser).click(By.css(`[data-detail-origin="catalog:card:${id}"]`));
    await reviewControls(browser).click(By.xpath('//summary[normalize-space(.)="Change artwork"]'));
    await browser.wait(until.elementLocated(control("Choose local image")), 15_000);
  };
  await open();
  const before = await state();
  assert.equal(before.resolved_source.kind, "igdb_cover");
  const local = path.join(output, "owned-local-choice.png");
  // Deliberately labelled test bytes, never authored or presented as game art.
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQCFgAAAGMAQm4OT/aAAAAAElFTkSuQmCC",
    "base64",
  );
  await writeFile(local, bytes, { flag: "wx" });
  artifactsPush(local);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await reviewControls(browser).click(control("Choose local image"));
  await confirmNative(
    "Choose local artwork",
    "Open",
    "File name:",
    "installed-local-cover-picker",
    local,
  );
  await browser.wait(async () => (await state()).choice.asset_sha256 === digest, 15_000);
  const selected = await state();
  browser = await restart("installed-local-choice-restart");
  await open();
  assert.deepEqual((await state()).choice, selected.choice);
  await reviewControls(browser).click(control("Refresh artwork"));
  await browser.wait(async () => (await state()).availability === "available", 15_000);
  assert.deepEqual((await state()).choice, selected.choice);
  await capture("installed-local-cover-survives-refresh-restart", true);
  const asset = path.join(library, "artwork", digest),
    retained = path.join(output, "retained-local-choice.png");
  assert.deepEqual(await readFile(asset), bytes);
  let withheld = false;
  let corrupted = false;
  const invalid = Buffer.from("controlled invalid local image bytes; native test only");
  try {
    browser = await restart("installed-local-choice-unavailable", async () => {
      await rename(asset, retained);
      withheld = true;
    });
    await open();
    const unavailable = await state();
    assert.equal(unavailable.availability, "unavailable");
    assert.deepEqual(unavailable.choice, selected.choice);
    assert.equal(unavailable.resolved_source.kind, "generated_fallback");
    await browser.wait(
      () =>
        executeBrowserScript(
          browser,
          () =>
            document.querySelector<HTMLElement>(".detail-cover")?.dataset.artworkSource ===
            "generated_fallback",
        ),
      15_000,
    );
    await capture("installed-unavailable-local-cover-retained", true);
    report.local_override = { before, selected, unavailable, controlled_missing_local_file: true };
    browser = await restart("installed-local-choice-corrupt", async () => {
      await writeFile(asset, invalid, { flag: "wx" });
      corrupted = true;
    });
    await open();
    const corrupt = await state();
    assert.equal(corrupt.availability, "unavailable");
    assert.deepEqual(corrupt.choice, selected.choice);
    assert.equal(corrupt.resolved_source.kind, "generated_fallback");
    await capture("installed-corrupt-local-cover-retained", true);
    report.local_override_corrupt = { state: corrupt, controlled_invalid_bytes: true };
  } finally {
    if (withheld) {
      browser = await restart("installed-local-choice-restored", async () => {
        if (corrupted) {
          assert.deepEqual(await readFile(asset), invalid);
          await unlink(asset);
          corrupted = false;
        }
        await rename(retained, asset);
        withheld = false;
      });
    }
  }
  await open();
  assert.deepEqual((await state()).choice, selected.choice);
  await reviewControls(browser).click(control("Reset to default"));
  await browser.wait(async () => (await state()).choice.asset_sha256 === null, 15_000);
  assert.equal((await state()).resolved_source.kind, "igdb_cover");
  await capture("installed-explicit-reset-current-default", true);
  report.local_override_reset = await state();
  assert.deepEqual(await readFile(local), bytes);
  function artifactsPush(file: string) {
    context.artifacts.push(file);
  }
}
