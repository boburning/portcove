import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebDriver } from "selenium-webdriver";
import { readPublicUpdateFile as readWindowsPublicExecutable } from "./desktop-public-update-files.mts";
import {
  readPublicUserState,
  assertPublicUserStateChoicesPreserved,
  seedPublicFavorite,
  selectPublicLightTheme,
  type PublicUserState,
} from "./desktop-public-update-state.mts";
import {
  DesktopNativeAccountSession,
  type AccountDriverView,
} from "./desktop-native-account-session.mts";
import type {
  CapturedNativeProcess,
  NativeProcessSnapshot,
} from "./desktop-owned-native-session.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import {
  retainWindowsPublicUpdatePreimages,
  prepareWindowsPublicJournalFault,
  prepareWindowsPublicPayloadFault,
} from "./desktop-windows-public-update-files.mts";

function sameProcess(a: CapturedNativeProcess, b: CapturedNativeProcess) {
  return (
    a.pid === b.pid &&
    a.started_filetime === b.started_filetime &&
    path.win32.resolve(a.path).toLowerCase() === path.win32.resolve(b.path).toLowerCase()
  );
}

/** Inert identity comparison. Only the account broker supplies actual process observations. */
export function selectWindowsPublicRelaunch(
  before: NativeProcessSnapshot,
  after: NativeProcessSnapshot,
  application: string,
) {
  assert.ok(path.win32.isAbsolute(application));
  assert.ok(before.processes.length <= 64 && after.processes.length <= 64);
  assert.ok(sameProcess(before.driver, after.driver), "Relaunch belongs to another account root");
  const atPath = (item: CapturedNativeProcess) =>
    path.win32.resolve(item.path).toLowerCase() === path.win32.resolve(application).toLowerCase();
  const prior = before.processes.filter(atPath);
  assert.equal(prior.length, 1, "Exactly one original installed process is required");
  assert.equal(prior[0]?.pid, before.application_pid);
  assert.ok(
    !after.processes.some((item) => sameProcess(item, prior[0]!)),
    "Original application remains live",
  );
  const current = after.processes.filter(atPath);
  assert.equal(current.length, 1, "Exactly one automatic installed relaunch is required");
  assert.equal(current[0]?.pid, after.application_pid);
  assert.ok(!sameProcess(prior[0], current[0]), "Original process cannot prove relaunch");
  return { prior: prior[0], relaunched: current[0] };
}

export { readPublicUpdateFile as readWindowsPublicExecutable } from "./desktop-public-update-files.mts";

export async function readWindowsPublicUserState(browser: WebDriver): Promise<PublicUserState> {
  const value = await readPublicUserState(browser, "win32");
  assert.ok(path.win32.isAbsolute(value.app_local_data));
  assert.ok(path.win32.isAbsolute(value.library_root));
  return value;
}

export function assertWindowsPublicUserStatePreserved(
  before: PublicUserState,
  after: PublicUserState,
) {
  assert.equal(
    path.win32.resolve(after.app_local_data).toLowerCase(),
    path.win32.resolve(before.app_local_data).toLowerCase(),
  );
  assert.equal(
    path.win32.resolve(after.library_root).toLowerCase(),
    path.win32.resolve(before.library_root).toLowerCase(),
  );
  assertPublicUserStateChoicesPreserved(before, after);
}

/** Actual Windows operation, to be called only by the fixed parent under its native grant.
 * It neither issues a Check nor establishes native acceptance/publication authority. */
export async function runWindowsPublicUpdateJourney(
  input: {
    binding: string;
    binding_sha256: string;
    application: string;
    output: string;
    prior_sha256: string;
    prior_version: string;
    candidate_sha256: string;
    candidate_installer_sha256: string;
    candidate_version: string;
  },
  deadline: number,
) {
  input = Object.freeze(structuredClone(input));
  assert.deepEqual(Object.keys(input).sort(), [
    "application",
    "binding",
    "binding_sha256",
    "candidate_installer_sha256",
    "candidate_sha256",
    "candidate_version",
    "output",
    "prior_sha256",
    "prior_version",
  ]);
  for (const name of ["application", "binding", "output"] as const)
    assert.ok(path.isAbsolute(input[name]));
  assert.equal(process.platform, "win32");
  assert.ok(
    Number.isFinite(deadline) &&
      deadline > performance.now() &&
      deadline <= performance.now() + 1750000,
  );
  for (const digest of [
    input.prior_sha256,
    input.candidate_sha256,
    input.candidate_installer_sha256,
    input.binding_sha256,
  ])
    assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.notEqual(input.prior_sha256, input.candidate_sha256);
  assert.notEqual(input.prior_version, input.candidate_version);
  assert.match(input.prior_version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
  assert.match(input.candidate_version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u);
  const session = DesktopNativeAccountSession.open(input.binding, input.binding_sha256);
  const runtime = session.runtimeRoot(input.output);
  const relative = path.relative(path.dirname(runtime), input.application);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Installed application must belong to this account invocation work root",
  );
  await mkdir(input.output, { recursive: false });
  await mkdir(runtime, { recursive: false });
  const environment = {
    PORTCOVE_LIBRARY: path.join(runtime, "library"),
    PORTCOVE_PREFERENCES: path.join(runtime, "preferences.json"),
    PORTCOVE_APPLICATION_UPDATE_PREFERENCES: path.join(runtime, "update-preferences.json"),
    PORTCOVE_APPLICATION_UPDATE_SCHEDULE: path.join(runtime, "update-schedule.json"),
    PORTCOVE_APPLICATION_UPDATE_STAGING: path.join(runtime, "staging"),
  };
  const { By, until } = await import("selenium-webdriver");
  const { driveInstalledUpdateToRestart, driveInstalledUpdateRecovery } =
    await import("./desktop-application-update-journey.mts");
  const { connectInstalledUpdateDriver, readInstalledUpdateStatus } =
    await import("./desktop-installed-update-harness.mts");
  const actions: string[] = [];
  const report: Record<string, unknown> = {
    schema_version: 1,
    authority: "none",
    native_acceptance: "not-established",
    actions,
  };
  report.harness = await readWindowsPublicExecutable(fileURLToPath(import.meta.url));
  let view: AccountDriverView | undefined, browser: WebDriver | undefined;
  let failure: Error | undefined;
  let launchSequence = 0,
    cleanupSequence = 0;
  const startupPreimages: Awaited<ReturnType<typeof retainWindowsPublicUpdatePreimages>>[] = [];
  report.startup_preimages = startupPreimages;
  const active = () =>
    assert.ok(performance.now() < deadline, "Original native journey deadline expired");
  const save = async () =>
    writeFile(
      path.join(input.output, "public-update-journey.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx" },
    );
  const connect = async (expectedVersion: string) => {
    active();
    startupPreimages.push(
      await retainWindowsPublicUpdatePreimages(
        runtime,
        path.join(input.output, `before-startup-${launchSequence++}`),
        deadline,
      ),
    );
    const tools = session.drivers();
    view = session.start(
      tools.tauri_driver,
      ["--port", "45770", "--native-port", "45771", "--native-driver", tools.webview_driver],
      runtime,
      environment,
    );
    const startupDeadline = Math.min(deadline, performance.now() + 10000);
    let listening = false;
    for (let attempt = 0; attempt < 20 && performance.now() < startupDeadline; attempt++) {
      active();
      assert.equal(view.exitCode, null, "Owned tauri-driver exited before readiness");
      const left = Math.floor(startupDeadline - performance.now());
      if (left < 1) break;
      const response = await fetch("http://127.0.0.1:45770/status", {
        signal: AbortSignal.timeout(Math.min(500, left)),
      }).catch(() => null);
      if (response?.ok) {
        listening = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(
      listening,
      "Owned tauri-driver did not become ready within its bounded startup window",
    );
    // Pinned Tauri 2.12.4 Windows default: app_local_data_dir(), not a custom WebView profile.
    const normalProfile = path.join(
      session.environment({}).USERPROFILE!,
      "AppData",
      "Local",
      "io.github.portcove.portcove",
    );
    browser = await connectInstalledUpdateDriver(input.application, normalProfile);
    await browser.manage().setTimeouts({ script: 15000, pageLoad: 30000, implicit: 0 });
    await browser.wait(until.elementLocated(By.css('nav[aria-label="Primary navigation"]')), 30000);
    const actual = await readWindowsPublicUserState(browser);
    assert.equal(actual.application_version, expectedVersion);
    assert.equal(
      path.resolve(actual.library_root).toLowerCase(),
      path.resolve(environment.PORTCOVE_LIBRARY).toLowerCase(),
    );
    assert.equal(
      path.resolve(actual.app_local_data).toLowerCase(),
      path.resolve(normalProfile).toLowerCase(),
      "Actual Known Folder differs from the fixed account ordinary profile",
    );
    active();
    return browser;
  };
  const stop = () => {
    if (!view) return;
    const snapshot = path.join(input.output, `cleanup-${cleanupSequence++}.json`);
    session.observe("SnapshotDriverTree", snapshot, input.application);
    const stopped = session.observe("StopDriver", snapshot, input.application);
    const exited = session.observe("Wait", snapshot, input.application);
    view = undefined;
    browser = undefined;
    return { stopped, exited };
  };
  const closeCurrentApplication = async (name: string) => {
    active();
    assert.ok(view);
    const file = path.join(input.output, `${name}-close.json`);
    const snapshot = session.observe("Snapshot", file, input.application);
    const application = snapshot.processes.find((item) => item.pid === snapshot.application_pid);
    assert.ok(application);
    const close = session.observe("RequestClose", file, input.application);
    const until = Math.min(deadline, performance.now() + 30000);
    while (session.observeRoot(view).processes.some((item) => sameProcess(item, application))) {
      assert.ok(performance.now() < until, "Owned application did not close naturally");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return close;
  };
  try {
    assert.equal((await readWindowsPublicExecutable(input.application)).sha256, input.prior_sha256);
    let initial = await connect(input.prior_version);
    report.favorite_port = await seedPublicFavorite(initial, "win32");
    await selectPublicLightTheme(initial);
    report.staging = await driveInstalledUpdateToRestart(initial, actions, input.candidate_version);
    active();
    let beforeState = await readWindowsPublicUserState(initial);
    assert.equal(beforeState.application_version, input.prior_version);
    assert.ok(beforeState.favorites.includes(String(report.favorite_port)));
    assertWindowsPublicUserStatePreserved(beforeState, beforeState);
    assert.equal(
      (await readWindowsPublicExecutable(path.join(runtime, "staging", "candidate-installer.exe")))
        .sha256,
      input.candidate_installer_sha256,
    );
    const tamperClose = await closeCurrentApplication("before-local-tamper");
    const tamperCleanup = stop();
    const tamperPreimages = await retainWindowsPublicUpdatePreimages(
      runtime,
      path.join(input.output, "before-local-payload-tamper"),
      deadline,
    );
    const tamper = await prepareWindowsPublicPayloadFault(runtime, deadline);
    active();
    initial = await connect(input.prior_version);
    const tamperRecovery = await driveInstalledUpdateRecovery(initial, actions, "staging");
    assert.equal((await readWindowsPublicExecutable(input.application)).sha256, input.prior_sha256);
    assertWindowsPublicUserStatePreserved(beforeState, await readWindowsPublicUserState(initial));
    report.local_payload_custody_refusal = {
      original: tamperPreimages,
      fault: tamper,
      closed: tamperClose,
      cleanup: tamperCleanup,
      recovery: tamperRecovery,
      scope: "native local custody refusal; cryptographic subtype not observable",
    };
    report.restaging = await driveInstalledUpdateToRestart(
      initial,
      actions,
      input.candidate_version,
    );
    active();
    assert.equal(
      (await readWindowsPublicExecutable(path.join(runtime, "staging", "candidate-installer.exe")))
        .sha256,
      input.candidate_installer_sha256,
    );
    const restagedState = await readWindowsPublicUserState(initial);
    assertWindowsPublicUserStatePreserved(beforeState, restagedState);
    beforeState = restagedState;
    await writeFile(
      path.join(input.output, "before-restart-user-state.json"),
      JSON.stringify(beforeState) + "\n",
      { flag: "wx" },
    );
    const before = session.observe(
      "Snapshot",
      path.join(input.output, "before-restart-processes.json"),
      input.application,
    );
    assert.equal((await readWindowsPublicExecutable(input.application)).sha256, input.prior_sha256);
    active();
    try {
      await initial
        .findElement(By.xpath('//button[normalize-space(.)="Restart to update"]'))
        .click();
    } catch (error) {
      report.restart_click_error = String(error).slice(0, 1024);
    }
    actions.push("ordinary-restart-button-attempted");
    let automatic: ReturnType<typeof selectWindowsPublicRelaunch> | undefined;
    let sequence = 0;
    const relaunchDeadline = Math.min(deadline, performance.now() + 120000);
    while (!automatic) {
      active();
      assert.ok(
        performance.now() < relaunchDeadline,
        "Automatic relaunch was not observed within 120 seconds",
      );
      const observed = session.observe(
        "SnapshotDriverTree",
        path.join(input.output, `relaunch-${sequence++}.json`),
        input.application,
      );
      if (sequence > 120) throw new Error("Automatic relaunch polling budget exhausted");
      let captured: ReturnType<typeof selectWindowsPublicRelaunch> | undefined;
      if (observed.application_pid !== null) {
        try {
          const bytesBefore = await readWindowsPublicExecutable(input.application);
          if (bytesBefore.sha256 === input.candidate_sha256) {
            const bracket = session.observe(
              "Snapshot",
              path.join(input.output, `relaunch-bracket-${sequence}.json`),
              input.application,
            );
            const selected = selectWindowsPublicRelaunch(before, bracket, input.application);
            const bytesAfter = await readWindowsPublicExecutable(input.application);
            assert.deepEqual(bytesAfter, bytesBefore);
            report.automatic_relaunch = {
              ...selected,
              executable: bytesAfter,
              scope: "owned-process identity and installed bytes",
            };
            captured = selected;
          }
        } catch (error) {
          report.last_relaunch_observation_error = String(error).slice(0, 1024);
        }
      }
      if (captured) {
        active();
        // Latch the one close request outside observational polling. Ambiguity cannot retry it.
        report.automatic_close = session.observe(
          "RequestClose",
          path.join(input.output, `relaunch-bracket-${sequence}.json`),
          input.application,
        );
        const closeDeadline = Math.min(deadline, performance.now() + 30000);
        assert.ok(view);
        while (
          session.observeRoot(view).processes.some((item) => sameProcess(item, captured.relaunched))
        ) {
          assert.ok(
            performance.now() < closeDeadline,
            "Automatically relaunched application did not close naturally",
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        automatic = captured;
      }
      if (!automatic) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    report.first_driver_cleanup = stop();
    actions.push("automatic-v1-observed-before-normal-ui-reopen");
    assert.equal(
      (await readWindowsPublicExecutable(input.application)).sha256,
      input.candidate_sha256,
    );
    const reopened = await connect(input.candidate_version);
    const afterState = await readWindowsPublicUserState(reopened);
    assert.equal(afterState.application_version, input.candidate_version);
    assertWindowsPublicUserStatePreserved(beforeState, afterState);
    const status = await readInstalledUpdateStatus(reopened);
    active();
    assert.equal(status.recovery_required.length, 0);
    report.user_state = {
      before: beforeState,
      after: afterState,
      scope: "separate normal V1 UI reopen",
    };
    report.final_status = status;
    report.public_reopen_close = await closeCurrentApplication("public-reopen");
    report.public_reopen_cleanup = stop();
    const recoveryCases: Record<string, unknown>[] = [];
    report.recovery_cases = recoveryCases;
    for (const area of ["schedule", "staging", "apply"] as const) {
      active();
      // stop() above proves this owned tree empty before the fixed fault mutation.
      const original = await retainWindowsPublicUpdatePreimages(
        runtime,
        path.join(input.output, `before-${area}-fault`),
        deadline,
      );
      const fault = await prepareWindowsPublicJournalFault(runtime, area, deadline);
      active();
      assert.equal(
        (await readWindowsPublicExecutable(input.application)).sha256,
        input.candidate_sha256,
      );
      const current = await connect(input.candidate_version);
      const recovery = await driveInstalledUpdateRecovery(current, actions, area);
      active();
      const retained = await readWindowsPublicUserState(current);
      assert.equal(retained.application_version, input.candidate_version);
      assertWindowsPublicUserStatePreserved(beforeState, retained);
      const closed = await closeCurrentApplication(`${area}-recovery`);
      const cleanup = stop();
      recoveryCases.push({ area, original, fault, recovery, retained, closed, cleanup });
      report.final_status = recovery.after;
    }
    report.outcome = "observed";
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("Ordinary public update journey failed", { cause: error });
    report.outcome = "failed";
    report.failure = String(error).slice(0, 4096);
  } finally {
    try {
      report.cleanup = stop();
    } catch (error) {
      report.cleanup_failure = String(error).slice(0, 4096);
      report.outcome = "failed";
      failure ??=
        error instanceof Error
          ? error
          : new Error("Ordinary public update cleanup failed", { cause: error });
    }
    try {
      await save();
    } catch (error) {
      failure = new AggregateError(
        [...(failure ? [failure] : []), error],
        "Ordinary public update evidence publication failed; preserve original errors",
      );
    }
  }
  if (failure) throw failure;
  assert.equal(report.outcome, "observed");
  return report;
}

export function inspectWindowsPublicUpdateConfiguration(raw: unknown) {
  assert.ok(isRecord(raw));
  assert.deepEqual(Object.keys(raw).sort(), ["journey", "kind", "schema_version"]);
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "ordinary-windows-public-update");
  const value = raw.journey;
  assert.ok(isRecord(value));
  assert.deepEqual(Object.keys(value).sort(), [
    "application",
    "binding",
    "binding_sha256",
    "candidate_installer_sha256",
    "candidate_sha256",
    "candidate_version",
    "output",
    "prior_sha256",
    "prior_version",
  ]);
  const text = (field: string) => {
    const result = value[field];
    assert.ok(typeof result === "string" && result.length > 0 && result.length <= 32768);
    return result;
  };
  return {
    binding: text("binding"),
    binding_sha256: text("binding_sha256"),
    application: text("application"),
    output: text("output"),
    prior_sha256: text("prior_sha256"),
    prior_version: text("prior_version"),
    candidate_sha256: text("candidate_sha256"),
    candidate_installer_sha256: text("candidate_installer_sha256"),
    candidate_version: text("candidate_version"),
  };
}

/** Exact fixed harness entry; JSON/config custody grants no native acceptance. */
export async function runFixedWindowsPublicUpdateConfiguration(
  file: string,
  expectedSha256: string,
  remainingMilliseconds: number,
) {
  assert.ok(path.isAbsolute(file));
  assert.match(expectedSha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    Number.isSafeInteger(remainingMilliseconds) &&
      remainingMilliseconds > 0 &&
      remainingMilliseconds <= 1750000,
  );
  const deadline = performance.now() + remainingMilliseconds;
  const before = await readWindowsPublicExecutable(file, 16384);
  assert.ok(before.bytes <= 16384);
  assert.equal(before.sha256, expectedSha256);
  const handle = await open(file, "r");
  const buffer = Buffer.alloc(16385);
  let read = 0;
  try {
    while (read < buffer.length) {
      const result = await handle.read(buffer, read, buffer.length - read, null);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  assert.ok(read > 0 && read <= 16384);
  const bytes = buffer.subarray(0, read);
  assert.equal(bytes.length, before.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
  const input = inspectWindowsPublicUpdateConfiguration(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  assert.deepEqual(await readWindowsPublicExecutable(file, 16384), before);
  assert.ok(performance.now() < deadline);
  return runWindowsPublicUpdateJourney(input, deadline);
}
