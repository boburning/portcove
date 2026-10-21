/** Ordinary shipped AppImage updater journey inside the already owned unit.
 * Observations only: no native Check, scheduler appointment or publication grant. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, open, readFile, statfs, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, By, until, type WebDriver } from "selenium-webdriver";
import { inspectPublicNativeLinuxBinding } from "./native-linux-public-plan.mts";
import { inspectNativeLinuxHomeMount } from "./native-linux-isolated-plan.mts";
import { launchPublicLinuxNativeSession } from "./native-linux-isolated-session.mts";
import {
  readPublicUserState,
  seedPublicFavorite,
  selectPublicLightTheme,
  assertPublicUserStateChoicesPreserved,
  type PublicUserState,
} from "./desktop-public-update-state.mts";
import {
  readPublicUpdateFile,
  createPublicUpdatePreimageStore,
  retainDeduplicatedPublicUpdatePreimages,
  preparePublicJournalFault,
  preparePublicPayloadFault,
} from "./desktop-public-update-files.mts";
import {
  driveInstalledUpdateToRestart,
  driveInstalledUpdateRecovery,
} from "./desktop-application-update-journey.mts";
import { readInstalledUpdateStatus } from "./desktop-installed-update-harness.mts";
import { isRecord, errorCode, errorMessage } from "../../../scripts/runtime-values.mts";

/** Integrity-only observation inspector. Actual namespace/parent custody is separate. */
export function inspectLinuxPublicRuntime(
  raw: unknown,
  packageIdentity: { bytes: number; sha256: string },
  prior?: { pid: number; creation_ticks: string },
) {
  assert.ok(isRecord(raw) && raw.schema_version === 1 && raw.authority === "none");
  assert.equal(raw.scope, "ordinary-public-broker-mounted-runtime");
  assert.equal(raw.namespace_owner_pid, 1);
  assert.ok(isRecord(raw.process));
  const process = raw.process;
  assert.ok(Number.isSafeInteger(process.pid) && Number(process.pid) > 1);
  assert.ok(typeof process.creation_ticks === "string" && /^[0-9]+$/u.test(process.creation_ticks));
  assert.ok(isRecord(process.opaque_mount));
  const association = process.opaque_mount;
  assert.ok(isRecord(association.runtime) && isRecord(association.runtime.package));
  assert.equal(association.runtime.package.bytes, packageIdentity.bytes);
  assert.equal(association.runtime.package.sha256, packageIdentity.sha256);
  assert.ok(isRecord(association.mount));
  assert.equal(association.mount.filesystem, "fuse.AppImage");
  assert.equal(association.mount.source, "/native/installation/Portcove.AppImage");
  if (prior)
    assert.ok(
      process.pid !== prior.pid || process.creation_ticks !== prior.creation_ticks,
      "Original application cannot prove automatic relaunch",
    );
  return {
    pid: Number(process.pid),
    creation_ticks: process.creation_ticks,
    observation: structuredClone(raw),
  };
}

async function seedInitialImage(
  binding: ReturnType<typeof inspectPublicNativeLinuxBinding>,
  deadline: number,
) {
  const active = () => assert.ok(performance.now() < deadline);
  active();
  inspectNativeLinuxHomeMount(
    await readFile("/proc/self/mountinfo", "utf8"),
    binding.session.home,
    await statfs(binding.session.home),
  );
  await mkdir(binding.state, { mode: 0o700 });
  await mkdir(binding.installation, { mode: 0o700 });
  const expected = binding.session.application;
  assert.equal((await readPublicUpdateFile(expected.path)).sha256, expected.sha256);
  const input = await open(
    expected.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output: FileHandle | undefined;
  try {
    output = await open(
      binding.active_application,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      active();
      const result = await input.read(buffer);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      assert.ok(bytes <= expected.bytes);
      hash.update(buffer.subarray(0, result.bytesRead));
      let offset = 0;
      while (offset < result.bytesRead) {
        active();
        const written = await output.write(buffer, offset, result.bytesRead - offset);
        assert.ok(written.bytesWritten > 0);
        offset += written.bytesWritten;
      }
    }
    assert.equal(bytes, expected.bytes);
    assert.equal(hash.digest("hex"), expected.sha256);
    await output.sync();
  } finally {
    await Promise.all([input.close(), ...(output ? [output.close()] : [])]);
  }
  assert.equal((await readPublicUpdateFile(expected.path)).sha256, expected.sha256);
  const copied = await readPublicUpdateFile(binding.active_application);
  assert.equal(copied.sha256, expected.sha256);
  assert.equal(copied.bytes, expected.bytes);
  return { ...copied, scope: "initial V0 installation only" };
}

export async function runLinuxPublicUpdateJourney(
  rawBinding: unknown,
  versions: { prior: string; candidate: string },
  originalDeadline: number,
) {
  const binding = inspectPublicNativeLinuxBinding(rawBinding);
  versions = Object.freeze(structuredClone(versions));
  assert.equal(process.platform, "linux");
  assert.deepEqual(Object.keys(versions).sort(), ["candidate", "prior"]);
  for (const version of Object.values(versions))
    assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u);
  assert.notEqual(versions.prior, versions.candidate);
  const deadline = Math.min(
    originalDeadline,
    performance.now() + Date.parse(binding.session.deadline_utc) - Date.now(),
  );
  assert.ok(Number.isFinite(deadline) && deadline > performance.now());
  const active = () =>
    assert.ok(performance.now() < deadline, "Original public journey lifetime expired");
  // Original payload plus two distinct 1MiB chunks for fault/partial bytes, ten raw
  // fixed sets of at most five 1MiB JSON files, plus 64MiB capture envelope.
  assert.ok(
    binding.candidate.bytes + 52 * 1024 * 1024 <= 192 * 1024 * 1024,
    "Public raw evidence cannot fit the unchanged 256MiB export bound",
  );
  const output = `${binding.session.capture_root}/public-journey`;
  await mkdir(output, { mode: 0o700 });
  const preimageStore = await createPublicUpdatePreimageStore(`${output}/preimage-store`);
  const retainPreimages = (directory: string) =>
    retainDeduplicatedPublicUpdatePreimages(binding.state, directory, preimageStore, deadline);
  const actions: string[] = [];
  const report: Record<string, unknown> = {
    schema_version: 1,
    authority: "none",
    native_acceptance: "not-established",
    scope: "ordinary public shipped AppImage updater observations",
    actions,
  };
  const environment = {
    PORTCOVE_LIBRARY: `${binding.profile_home}/library`,
    PORTCOVE_PREFERENCES: `${binding.profile_home}/preferences.json`,
    PORTCOVE_APPLICATION_UPDATE_PREFERENCES: `${binding.profile_home}/update-preferences.json`,
    PORTCOVE_APPLICATION_UPDATE_SCHEDULE: `${binding.profile_home}/update-schedule.json`,
    PORTCOVE_APPLICATION_UPDATE_STAGING: `${binding.profile_home}/staging`,
  };
  let launched: Awaited<ReturnType<typeof launchPublicLinuxNativeSession>> | undefined;
  let browser: WebDriver | undefined;
  let sequence = 0;
  let failure: Error | undefined;
  const cleanups: unknown[] = [],
    preimages: unknown[] = [];
  report.cleanups = cleanups;
  report.startup_preimages = preimages;
  const stop = async () => {
    if (!launched) return;
    const current = launched;
    browser = undefined;
    const result = await current.stop();
    cleanups.push(result);
    launched = undefined;
    active();
    return result;
  };
  const readState = async () => {
    assert.ok(browser);
    const state = await readPublicUserState(browser, "linux");
    assert.equal(state.library_root, environment.PORTCOVE_LIBRARY);
    assert.ok(
      path.posix.isAbsolute(state.app_local_data) &&
        state.app_local_data.startsWith(binding.profile_home + "/"),
    );
    return state;
  };
  const connect = async (version: string) => {
    active();
    assert.ok(!launched && sequence < 6, "Public journey cannot repeat an existing namespace");
    preimages.push(await retainPreimages(`${output}/before-startup-${sequence++}`));
    const tools = binding.session.tools;
    launched = await launchPublicLinuxNativeSession(
      rawBinding,
      tools.driver!.path,
      ["--port", "45770", "--native-port", "45771", "--native-driver", tools.webkit_driver!.path],
      environment,
      active,
    );
    await launched.ready();
    browser = await new Builder()
      .disableEnvironmentOverrides()
      .usingServer("http://127.0.0.1:45770")
      .usingHttpAgent(launched.privateAgent)
      .withCapabilities({
        browserName: "wry",
        "tauri:options": { application: "/native/installation/Portcove.AppImage" },
      })
      .build();
    await browser.manage().setTimeouts({
      script: Math.min(15000, Math.max(1, Math.floor(deadline - performance.now()))),
      pageLoad: Math.min(30000, Math.max(1, Math.floor(deadline - performance.now()))),
      implicit: 0,
    });
    await browser.wait(
      until.elementLocated(By.css('nav[aria-label="Primary navigation"]')),
      Math.min(30000, Math.max(1, deadline - performance.now())),
    );
    const state = await readState();
    assert.equal(state.application_version, version);
    active();
    return browser;
  };
  const observe = async (
    identity: { bytes: number; sha256: string },
    prior?: { pid: number; creation_ticks: string },
  ) => {
    assert.ok(launched);
    const end = Math.min(deadline, performance.now() + 120000);
    for (let attempt = 0; attempt < 120 && performance.now() < end; attempt++) {
      active();
      try {
        const raw = await launched.observeRuntime();
        if (
          isRecord(raw) &&
          isRecord(raw.process) &&
          isRecord(raw.process.opaque_mount) &&
          isRecord(raw.process.opaque_mount.runtime) &&
          isRecord(raw.process.opaque_mount.runtime.package) &&
          raw.process.opaque_mount.runtime.package.sha256 === identity.sha256
        ) {
          const result = inspectLinuxPublicRuntime(raw, identity, prior);
          const installed = await readPublicUpdateFile(binding.active_application);
          assert.equal(installed.sha256, identity.sha256);
          assert.equal(installed.bytes, identity.bytes);
          active();
          return { ...result, installed };
        }
      } catch (error) {
        if (errorCode(error) !== "ERR_NATIVE_PUBLIC_RUNTIME_NOT_READY") throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000, Math.max(1, end - performance.now()))),
      );
    }
    throw new Error("Actual public package relaunch was not observed within the original bound");
  };
  let beforeState: PublicUserState | undefined;
  try {
    report.initial_installation = await seedInitialImage(binding, deadline);
    let current = await connect(versions.prior);
    report.favorite_port = await seedPublicFavorite(current, "linux");
    await selectPublicLightTheme(current);
    report.staging = await driveInstalledUpdateToRestart(current, actions, versions.candidate);
    beforeState = await readState();
    assert.ok(beforeState.favorites.includes(String(report.favorite_port)));
    assertPublicUserStateChoicesPreserved(beforeState, beforeState);
    assert.equal(
      (await readPublicUpdateFile(`${binding.state}/staging/candidate-installer.exe`)).sha256,
      binding.candidate.sha256,
    );
    report.before_local_tamper_cleanup = await stop();
    const original = await retainPreimages(`${output}/before-local-payload-tamper`);
    const fault = await preparePublicPayloadFault(binding.state, deadline);
    current = await connect(versions.prior);
    const recovered = await driveInstalledUpdateRecovery(current, actions, "staging");
    assert.equal(
      (await readPublicUpdateFile(binding.active_application)).sha256,
      binding.session.application.sha256,
    );
    assertPublicUserStateChoicesPreserved(beforeState, await readState());
    report.local_payload_custody_refusal = {
      original,
      fault,
      recovered,
      scope: "native local custody refusal; cryptographic subtype not observable",
    };
    report.restaging = await driveInstalledUpdateToRestart(current, actions, versions.candidate);
    assert.equal(
      (await readPublicUpdateFile(`${binding.state}/staging/candidate-installer.exe`)).sha256,
      binding.candidate.sha256,
    );
    assertPublicUserStateChoicesPreserved(beforeState, await readState());
    const prior = await observe(binding.session.application);
    report.before_restart_runtime = prior;
    // One ordinary click. A lost response is retained; no repeat or harness replacement.
    try {
      await current
        .findElement(By.xpath('//button[normalize-space(.)="Restart to update"]'))
        .click();
    } catch (error) {
      report.restart_click_error = errorMessage(error).slice(0, 1024);
    }
    actions.push("ordinary-restart-button-attempted");
    report.automatic_relaunch = await observe(binding.candidate, prior);
    report.automatic_relaunch_cleanup = await stop();
    actions.push("automatic-v1-observed-before-normal-ui-reopen");
    current = await connect(versions.candidate);
    const after = await readState();
    assertPublicUserStateChoicesPreserved(beforeState, after);
    report.user_state = {
      before: beforeState,
      after,
      scope: "same retained state; separate normal V1 UI reopen",
    };
    report.final_status = await readInstalledUpdateStatus(current);
    assert.equal(
      (report.final_status as Awaited<ReturnType<typeof readInstalledUpdateStatus>>)
        .recovery_required.length,
      0,
    );
    await stop();
    const recovery: unknown[] = [];
    report.recovery_cases = recovery;
    for (const area of ["schedule", "staging", "apply"] as const) {
      active();
      const original = await retainPreimages(`${output}/before-${area}-fault`);
      const fault = await preparePublicJournalFault(binding.state, area, deadline);
      current = await connect(versions.candidate);
      const result = await driveInstalledUpdateRecovery(current, actions, area);
      const retained = await readState();
      assertPublicUserStateChoicesPreserved(beforeState, retained);
      assert.equal(
        (await readPublicUpdateFile(binding.active_application)).sha256,
        binding.candidate.sha256,
      );
      const cleanup = await stop();
      recovery.push({ area, original, fault, result, retained, cleanup });
    }
    report.outcome = "observed";
  } catch (error) {
    failure =
      error instanceof Error ? error : new Error("Public Linux journey failed", { cause: error });
    report.outcome = "failed";
    report.failure = errorMessage(error).slice(0, 4096);
  } finally {
    try {
      await stop();
    } catch (error) {
      failure ??=
        error instanceof Error ? error : new Error("Public Linux cleanup failed", { cause: error });
      report.outcome = "failed";
      report.cleanup_failure = errorMessage(error).slice(0, 4096);
    }
    try {
      await writeFile(
        `${output}/public-update-journey.json`,
        JSON.stringify(report, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      failure = new AggregateError(
        [...(failure ? [failure] : []), error],
        "Public Linux journey evidence failed; preserve original captures",
      );
    }
  }
  if (failure) throw failure;
  return report;
}

/** Fixed credential-free guest CLI. A pinned plan is instructions, not a grant. */
export async function runFixedLinuxPublicUpdateConfiguration(
  filename: string,
  expectedSha256: string,
  remainingMilliseconds: number,
) {
  assert.equal(process.platform, "linux");
  assert.ok(path.posix.isAbsolute(filename));
  assert.match(expectedSha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    Number.isSafeInteger(remainingMilliseconds) &&
      remainingMilliseconds > 0 &&
      remainingMilliseconds <= 1750000,
  );
  const deadline = performance.now() + remainingMilliseconds;
  const before = await readPublicUpdateFile(filename, 128 * 1024);
  assert.equal(before.sha256, expectedSha256);
  const bytes = await readFile(filename);
  assert.equal(bytes.length, before.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedSha256);
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") === "binding,kind,schema_version,versions" &&
      raw.schema_version === 1 &&
      raw.kind === "ordinary-linux-public-update",
  );
  const binding = inspectPublicNativeLinuxBinding(raw.binding);
  assert.equal(filename, `${binding.session.capture_root}/public-linux-configuration.json`);
  assert.equal(
    fileURLToPath(import.meta.url),
    `${binding.session.controller.root}/apps/desktop/scripts/desktop-linux-public-update.mts`,
  );
  assert.ok(
    isRecord(raw.versions) && Object.keys(raw.versions).sort().join(",") === "candidate,prior",
  );
  assert.ok(typeof raw.versions.prior === "string" && typeof raw.versions.candidate === "string");
  assert.deepEqual(await readPublicUpdateFile(filename, 128 * 1024), before);
  return runLinuxPublicUpdateJourney(
    raw.binding,
    { prior: raw.versions.prior, candidate: raw.versions.candidate },
    deadline,
  );
}
async function cli() {
  const [flag, filename, shaFlag, sha, remainingFlag, remaining, ...rest] = process.argv.slice(2);
  assert.ok(
    flag === "--configuration" &&
      filename &&
      shaFlag === "--configuration-sha256" &&
      sha &&
      remainingFlag === "--remaining-ms" &&
      remaining &&
      !rest.length,
  );
  await runFixedLinuxPublicUpdateConfiguration(filename, sha, Number(remaining));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await cli();
