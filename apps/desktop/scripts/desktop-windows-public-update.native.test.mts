import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, link, mkdir, readFile, stat, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import type { WebDriver } from "selenium-webdriver";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  selectWindowsPublicRelaunch,
  readWindowsPublicExecutable,
  assertWindowsPublicUserStatePreserved,
  inspectWindowsPublicUpdateConfiguration,
  readWindowsPublicUserState,
  runFixedWindowsPublicUpdateConfiguration,
} from "./desktop-windows-public-update.mts";
import {
  retainWindowsPublicUpdatePreimages,
  prepareWindowsPublicJournalFault,
  prepareWindowsPublicPayloadFault,
} from "./desktop-windows-public-update-files.mts";

const application = "C:\\qualification\\install\\Portcove.exe";
const driver = { pid: 1, started_filetime: "100", path: "C:\\fixed\\tauri-driver.exe" };
const prior = { pid: 2, started_filetime: "200", path: application };
const next = { pid: 3, started_filetime: "300", path: application };
const snapshot = (processes = [driver, prior], application_pid: number | null = 2) => ({
  captured_at: "2026-10-21T00:00:00.000Z",
  driver,
  application_pid,
  processes,
});

void test("parked B child configuration is an explicit closed phase and cannot select a V2 continuation or keep-installed boolean", () => {
  const journey = {
    binding: "C:\\fixed\\binding.json",
    binding_sha256: "a".repeat(64),
    application,
    output: "C:\\capture\\public",
    prior_sha256: "b".repeat(64),
    prior_version: "0.1.0-beta.1",
    candidate_sha256: "c".repeat(64),
    candidate_installer_sha256: "d".repeat(64),
    candidate_version: "0.1.0-beta.2",
    phase: "park-v0-with-v1",
  };
  const raw = { schema_version: 2, kind: "ordinary-windows-public-update", journey };
  assert.equal(inspectWindowsPublicUpdateConfiguration(raw).phase, "park-v0-with-v1");
  for (const value of [
    { ...raw, schema_version: 1 },
    { ...raw, journey: { ...journey, phase: "continue-with-v2" } },
    { ...raw, journey: { ...journey, keep_installed: true } },
  ])
    assert.throws(() => inspectWindowsPublicUpdateConfiguration(value));
});

void test("public relaunch requires original exit and a distinct exact installed identity", () => {
  assert.deepEqual(
    selectWindowsPublicRelaunch(snapshot(), snapshot([driver, next], 3), application),
    {
      prior,
      relaunched: next,
    },
  );
  assert.throws(
    () => selectWindowsPublicRelaunch(snapshot(), snapshot(), application),
    /remains live/u,
  );
  assert.throws(
    () => selectWindowsPublicRelaunch(snapshot(), snapshot([driver, prior, next], 3), application),
    /remains live/u,
  );
  assert.throws(
    () => selectWindowsPublicRelaunch(snapshot(), snapshot([driver], null), application),
    /Exactly one automatic/u,
  );
  assert.throws(
    () =>
      selectWindowsPublicRelaunch(
        snapshot(),
        snapshot([driver, { ...next, path: "C:\\other\\Portcove.exe" }], 3),
        application,
      ),
    /Exactly one automatic/u,
  );
  assert.throws(
    () =>
      selectWindowsPublicRelaunch(
        snapshot(),
        { ...snapshot([driver, next], 3), driver: { ...driver, started_filetime: "101" } },
        application,
      ),
    /another account root/u,
  );
});

void test("V2 continuation has a separate exact schema with parent-retained B paths and report pin", () => {
  const continuation = {
    application,
    install_root: "C:\\qualification\\install",
    library_root: "C:\\qualification\\library",
    parked_executable_sha256: "a".repeat(64),
    parked_installer_sha256: "b".repeat(64),
    parked_version: "0.1.0-beta.2",
    previous_invocation_id: "c".repeat(64),
    previous_report: {
      path: "C:\\capture\\old\\public-update-journey.json",
      bytes: 1024,
      sha256: "d".repeat(64),
    },
    registration_path:
      "Microsoft.PowerShell.Core\\Registry::HKEY_USERS\\S-1-5-21-1-2-3-1003\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Portcove",
    run_root: "C:\\qualification\\run",
    runtime_root: "C:\\qualification\\runtime",
    test_base: "C:\\qualification\\installer",
    uninstaller: "C:\\qualification\\install\\uninstall.exe",
    uninstaller_sha256: "e".repeat(64),
    work_root: "C:\\qualification",
  };
  const raw = {
    schema_version: 3,
    kind: "ordinary-windows-public-update",
    journey: {
      application,
      binding: "C:\\owner\\binding.json",
      binding_sha256: "f".repeat(64),
      output: "C:\\capture\\current\\ordinary-public-update",
      prior_sha256: "1".repeat(64),
      prior_version: "0.1.0-beta.1",
      candidate_sha256: "2".repeat(64),
      candidate_installer_sha256: "3".repeat(64),
      candidate_version: "0.1.0-beta.3",
      phase: "continue-with-v2",
      continuation,
    },
  };
  const value = inspectWindowsPublicUpdateConfiguration(raw);
  assert.equal(value.phase, "continue-with-v2");
  assert.deepEqual(value.continuation, continuation);
  for (const changed of [
    { ...raw, schema_version: 2 },
    { ...raw, journey: { ...raw.journey, phase: "park-v0-with-v1" } },
    {
      ...raw,
      journey: { ...raw.journey, continuation: { ...continuation, keep_installed: true } },
    },
    {
      ...raw,
      journey: {
        ...raw.journey,
        continuation: {
          ...continuation,
          previous_report: { ...continuation.previous_report, bytes: 4 * 1024 * 1024 + 1 },
        },
      },
    },
  ])
    assert.throws(() => inspectWindowsPublicUpdateConfiguration(changed));
});

void test("PID reuse needs changed creation identity and cannot silently change the original capture", () => {
  const reused = { ...next, pid: prior.pid };
  assert.equal(
    selectWindowsPublicRelaunch(snapshot(), snapshot([driver, reused], reused.pid), application)
      .relaunched.started_filetime,
    "300",
  );
  assert.throws(() =>
    selectWindowsPublicRelaunch(
      { ...snapshot(), application_pid: null },
      snapshot([driver, next], 3),
      application,
    ),
  );
  assert.throws(() =>
    selectWindowsPublicRelaunch(
      snapshot(),
      snapshot([driver, next, { ...next, pid: 4 }], 3),
      application,
    ),
  );
});

void test("real installed-byte readback refuses empty and aliased regular files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-executable-"));
  try {
    const file = path.join(directory, "application.exe");
    await writeFile(file, Buffer.from([77, 90, 0, 1]));
    const observed = await readWindowsPublicExecutable(file);
    assert.equal(observed.bytes, 4);
    assert.match(observed.sha256, /^[a-f0-9]{64}$/u);
    await writeFile(file, Buffer.alloc(0));
    await assert.rejects(readWindowsPublicExecutable(file));
    await writeFile(file, Buffer.from([77, 90]));
    await link(file, path.join(directory, "alias.exe"));
    await assert.rejects(readWindowsPublicExecutable(file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("retained state requires a real favorite, appearance choice and exact update preferences", () => {
  const before = {
    application_origin: "http://tauri.localhost" as const,
    application_url: "http://tauri.localhost/",
    app_local_data: "C:\\qualification\\AppData\\Local\\io.github.portcove.portcove",
    application_version: "1.0.0",
    library_root: "C:\\qualification\\library",
    favorites: ["actual-catalog-port"],
    theme_preference: "light",
    rendered_theme: "light",
    update_preferences: {
      schema_version: 1,
      choice: { channel: "preview", mode: "manual", paused: false },
      revision: 1,
    },
  };
  assert.doesNotThrow(() => assertWindowsPublicUserStatePreserved(before, structuredClone(before)));
  assert.throws(
    () =>
      assertWindowsPublicUserStatePreserved(
        { ...before, favorites: [] },
        { ...before, favorites: [] },
      ),
    /empty library/u,
  );
  for (const after of [
    { ...before, favorites: [] },
    { ...before, library_root: "C:\\different-library" },
    { ...before, theme_preference: "system" },
    { ...before, rendered_theme: "dark" },
    {
      ...before,
      update_preferences: {
        ...before.update_preferences,
        choice: { ...before.update_preferences.choice, channel: "stable" },
      },
    },
  ])
    assert.throws(() => assertWindowsPublicUserStatePreserved(before, after));
  assert.doesNotThrow(() =>
    assertWindowsPublicUserStatePreserved(before, {
      ...before,
      update_preferences: { ...before.update_preferences, revision: 2 },
    }),
  );
});

void test("raw fixed journal and payload preimages survive malformed input and subsequent mutation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-preimages-"));
  try {
    const runtime = path.join(directory, "runtime"),
      output = path.join(directory, "retained");
    await mkdir(path.join(runtime, "staging"), { recursive: true });
    await writeFile(path.join(runtime, "staging", "staging.json"), "{");
    const payload = Buffer.from([77, 90, 0, 1, 2, 255]);
    await writeFile(path.join(runtime, "staging", "candidate-installer.exe"), payload);
    const result = await retainWindowsPublicUpdatePreimages(
      runtime,
      output,
      performance.now() + 10000,
    );
    assert.equal(result.files.length, 7);
    assert.equal(result.authority, "none");
    assert.deepEqual(await readFile(path.join(output, "staging-candidate-installer.exe")), payload);
    const faultPayload = await prepareWindowsPublicPayloadFault(runtime, performance.now() + 10000);
    assert.equal(faultPayload.before_byte ^ 1, faultPayload.after_byte);
    assert.notDeepEqual(
      await readFile(path.join(runtime, "staging", "candidate-installer.exe")),
      payload,
    );
    assert.equal(await readFile(path.join(output, "staging-staging.json"), "utf8"), "{");
    assert.equal(
      result.files.find((item) => item.path === "staging/candidate-installer.exe")?.sha256,
      createHash("sha256").update(payload).digest("hex"),
    );
    await writeFile(path.join(runtime, "staging", "candidate-installer.exe"), "changed");
    assert.deepEqual(await readFile(path.join(output, "staging-candidate-installer.exe")), payload);
    for (const area of ["schedule", "staging", "apply"] as const) {
      const fault = await prepareWindowsPublicJournalFault(
        runtime,
        area,
        performance.now() + 10000,
      );
      assert.equal(await readFile(path.join(runtime, fault.path), "utf8"), "{");
      assert.equal(fault.bytes, 1);
    }
    const absent = path.join(directory, "no-expired-output");
    await assert.rejects(
      retainWindowsPublicUpdatePreimages(runtime, absent, performance.now() - 1),
    );
    await assert.rejects(stat(absent), { code: "ENOENT" });
    await link(path.join(runtime, "staging", "staging.json"), path.join(directory, "alias"));
    await assert.rejects(
      retainWindowsPublicUpdatePreimages(
        runtime,
        path.join(directory, "alias-refusal"),
        performance.now() + 10000,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("raw-state helpers refuse a redirected runtime ancestor before fault writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-reparse-"));
  try {
    const outside = path.join(directory, "outside"),
      redirected = path.join(directory, "redirected");
    await mkdir(path.join(outside, "runtime", "staging"), { recursive: true });
    await writeFile(
      path.join(outside, "runtime", "staging", "candidate-installer.exe"),
      "unchanged",
    );
    await symlink(outside, redirected, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      retainWindowsPublicUpdatePreimages(
        path.join(redirected, "runtime"),
        path.join(directory, "refused"),
        performance.now() + 10000,
      ),
    );
    await assert.rejects(
      prepareWindowsPublicPayloadFault(path.join(redirected, "runtime"), performance.now() + 10000),
    );
    assert.equal(
      await readFile(path.join(outside, "runtime", "staging", "candidate-installer.exe"), "utf8"),
      "unchanged",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("public configuration cannot introduce origins, qualification flags or marker paths", () => {
  const journey = {
    binding: "C:\\account.json",
    binding_sha256: "a".repeat(64),
    application,
    output: "C:\\capture\\public",
    prior_sha256: "b".repeat(64),
    prior_version: "1.0.0-beta.1",
    candidate_sha256: "c".repeat(64),
    candidate_installer_sha256: "d".repeat(64),
    candidate_version: "1.0.0-beta.2",
  };
  const input = { schema_version: 1, kind: "ordinary-windows-public-update", journey };
  assert.deepEqual(inspectWindowsPublicUpdateConfiguration(input), journey);
  for (const field of [
    "metadata_url",
    "targets_url",
    "stage_marker",
    "qualification_environment",
  ]) {
    assert.throws(() =>
      inspectWindowsPublicUpdateConfiguration({
        ...input,
        journey: { ...journey, [field]: "unreviewed" },
      }),
    );
  }
  assert.throws(() =>
    inspectWindowsPublicUpdateConfiguration({ ...input, kind: "accepted-native-report" }),
  );
});

void test("actual ordinary state callback binds packaged origin, known folder and compiled version", async () => {
  const commands: string[] = [];
  const results: Record<string, unknown> = {
    get_bootstrap_status: {
      ready: true,
      generation: 0,
      library_root: "C:\\qualification\\library",
    },
    get_favorite_ports: ["actual-catalog-port"],
    "plugin:path|resolve_directory":
      "C:\\qualification\\AppData\\Local\\io.github.portcove.portcove",
    "plugin:app|version": "1.0.0-beta.2",
    get_application_update_preferences: {
      schema_version: 1,
      revision: 2,
      choice: { channel: "preview", mode: "manual", paused: false },
    },
  };
  let origin = "http://tauri.localhost";
  const browser = {
    executeAsyncScript: async (
      callback: (platform: string, done: (result: string) => void) => unknown,
      platform: string,
    ) =>
      new Promise<string>((resolve) => {
        runInNewContext(`(${callback.toString()})(platform, done)`, {
          platform,
          done: resolve,
          location: { origin, href: origin + "/" },
          window: {
            __TAURI_INTERNALS__: {
              invoke: async (command: string, args?: object) => {
                commands.push(command);
                assert.ok(Object.hasOwn(results, command));
                if (command === "plugin:path|resolve_directory")
                  assert.equal(JSON.stringify(args), '{"directory":15}');
                return results[command];
              },
            },
          },
          localStorage: {
            getItem: (key: string) => {
              assert.equal(key, "portcove.appearance.theme");
              return "light";
            },
          },
          document: { documentElement: { dataset: { theme: "light" } } },
        });
      }),
  } as unknown as WebDriver;
  const observed = await readWindowsPublicUserState(browser);
  assert.equal(observed.application_version, "1.0.0-beta.2");
  assert.equal(observed.app_local_data, results["plugin:path|resolve_directory"]);
  assert.ok(
    commands.every((command) => !command.startsWith("set_") && !command.startsWith("recover_")),
  );
  commands.length = 0;
  origin = "https://untrusted.invalid";
  await assert.rejects(readWindowsPublicUserState(browser));
  assert.deepEqual(commands, []);
});

void test("fixed entry refuses changed configuration and exhausted lifetime before account access", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-entry-"));
  try {
    const file = path.join(directory, "configuration.json");
    await writeFile(file, "{}");
    await assert.rejects(runFixedWindowsPublicUpdateConfiguration(file, "f".repeat(64), 10000));
    await assert.rejects(
      runFixedWindowsPublicUpdateConfiguration(
        file,
        createHash("sha256").update("{}").digest("hex"),
        0,
      ),
    );
    await assert.rejects(
      runFixedWindowsPublicUpdateConfiguration(
        file,
        createHash("sha256").update("{}").digest("hex"),
        10000,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test(
  "actual installer public-entry guards refuse unappointed source and version before account access",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-installer-entry-"));
    try {
      const installer = path.join(directory, "inert.exe"),
        configuration = path.join(directory, "inputs.json");
      await writeFile(installer, "inert bytes; never executed");
      const input = {
        schema_version: 1,
        kind: "ordinary-public-windows-update-inputs",
        prior_installer_sha256: createHash("sha256")
          .update("inert bytes; never executed")
          .digest("hex"),
        prior_executable_sha256: "b".repeat(64),
        prior_version: "1.0.0-beta.1",
        candidate_executable_sha256: "c".repeat(64),
        candidate_installer_sha256: "d".repeat(64),
        candidate_version: "1.0.0-beta.2",
      };
      for (const change of [
        { schema_version: 2, phase: "continue-with-v2" },
        { metadata_url: "https://untrusted.invalid/" },
        { prior_version: "different" },
        { candidate_version: input.prior_version },
      ]) {
        const bytes = JSON.stringify({ ...input, ...change });
        await writeFile(configuration, bytes);
        const result = spawnSync(
          "pwsh",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            fileURLToPath(new URL("../../../scripts/test-windows-installer.ps1", import.meta.url)),
            "-InstallerPath",
            installer,
            "-ExpectedVersion",
            input.prior_version,
            "-NativeParentOwnsFinish",
            "-NativeAccountBindingPath",
            path.join(directory, "absent-binding.json"),
            "-NativeAccountBindingSha256",
            "a".repeat(64),
            "-OrdinaryPublicUpdateInputsPath",
            configuration,
            "-OrdinaryPublicUpdateInputsSha256",
            createHash("sha256").update(bytes).digest("hex"),
            "-OrdinaryPublicUpdateRemainingMilliseconds",
            "10000",
          ],
          { encoding: "utf8", timeout: 15000, maxBuffer: 128 * 1024, windowsHide: true },
        );
        assert.equal(result.status, 1, result.stderr);
        assert.match(
          stripVTControlCharacters(result.stderr).replaceAll(/\s+/gu, " "),
          /Ordinary public update (?:fixed input schema differs|version absent|park phase differs|must begin with the distinct exact appointed V0)/u,
        );
        await assert.rejects(stat(path.join(directory, "absent-binding.json")), { code: "ENOENT" });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
