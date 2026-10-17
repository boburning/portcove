import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { parseRealRuntimeInput, runtimeMutable } from "./desktop-real-runtime-inputs.mts";

void test("real runtime restarts retain distinct exclusive driver launch receipts", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-runtime-launch-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function captureBackupFocusDriverLaunch(");
  const end = source.indexOf("async function driverReady()", start);
  assert.ok(start >= 0 && end > start);
  const now = Date.now();
  const driverPath = path.join(output, "selected-driver.exe");
  const artifacts: string[] = [];
  const ownedSession: { driver?: unknown } = {};
  const context = {
    assert,
    path,
    required: (value: unknown) => {
      assert.ok(value);
      return value;
    },
    driver: { pid: 101 },
    driverPath,
    output,
    artifacts,
    ownedSession,
    cleanupName: "real-prepared-runtime",
    hostInterruptionSession: false,
    ordinaryCloseSession: false,
    savedLibraryRecoverySession: false,
    selection: { selected_scenarios: ["native-real-prepared-runtime"] },
    observeNativeSession: (mode: string, snapshot: string) => {
      assert.equal(mode, "SnapshotDriver");
      const captured = {
        driver: {
          pid: context.driver.pid,
          path: driverPath,
          started_filetime: String((BigInt(now) + 11_644_473_600_000n) * 10_000n),
        },
      };
      writeFileSync(snapshot, JSON.stringify(captured), { flag: "wx" });
      return captured;
    },
  };
  const capture = runInNewContext(
    `${stripTypeScriptTypes(source.slice(start, end))}; captureBackupFocusDriverLaunch`,
    context,
  ) as (started: number) => void;
  for (const pid of [101, 202, 303]) {
    context.driver = { pid };
    capture(now);
  }
  assert.equal(new Set(artifacts).size, 3);
  assert.deepEqual(
    artifacts.map((file) => path.basename(file)),
    [101, 202, 303].map((pid) => `real-prepared-runtime-driver-startup-${pid}.json`),
  );
  assert.throws(() => capture(now), { code: "EEXIST" });
});

void test("real runtime review waits for the actual visible enabled action after preview", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-real-runtime-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  async function review(kind:");
  const end = source.indexOf("  for (const item of fixture.packages)", start);
  assert.ok(start >= 0 && end > start);
  let controls: object[] = [];
  const dialog = {
    isDisplayed: async () => true,
    findElements: async () => controls,
  };
  let poll: (() => Promise<unknown>) | undefined;
  const review = runInNewContext(`${stripTypeScriptTypes(source.slice(start, end))}; review`, {
    assert,
    By: { css: (value: string) => value, xpath: (value: string) => value },
    browser: {
      findElements: async () => [dialog],
      wait: async (predicate: () => Promise<unknown>, timeout: number) => {
        assert.equal(timeout, 15_000);
        poll = predicate;
        return predicate();
      },
    },
  }) as (kind: string, action: string) => Promise<unknown>;
  assert.equal(await review("register", "Use this installation"), false);
  assert.ok(poll);
  controls = [{ isDisplayed: async () => false, isEnabled: async () => true }];
  assert.equal(await poll(), false);
  controls = [{ isDisplayed: async () => true, isEnabled: async () => false }];
  assert.equal(await poll(), false);
  const control = { isDisplayed: async () => true, isEnabled: async () => true };
  controls = [control];
  const ready = (await poll()) as { dialog: unknown; control: unknown };
  assert.equal(ready.dialog, dialog);
  assert.equal(ready.control, control);
  controls = [control, control];
  await assert.rejects(poll, /must be unique/);
});

function input() {
  return {
    format_version: 1,
    source: path.join(os.tmpdir(), "owned-original.Z64"),
    packages: ["wave-race-64-recomp", "wave-race-64-racewave46"].map((port_id) => ({
      port_id,
      archive: path.join(os.tmpdir(), `${port_id}.zip`),
      directory: path.join(os.tmpdir(), port_id),
    })),
  };
}

void test("real runtime manifest selects both distinct retained routes without definition overrides", () => {
  assert.deepEqual(parseRealRuntimeInput(input()), input());
  const duplicate = input();
  duplicate.packages[1] = { ...duplicate.packages[0]! };
  assert.throws(() => parseRealRuntimeInput(duplicate));
  const incomplete = input();
  incomplete.packages.pop();
  assert.throws(() => parseRealRuntimeInput(incomplete));
  assert.throws(() => parseRealRuntimeInput({ ...input(), catalog_override: "unreviewed.json" }));
  const relative = input();
  relative.source = "relative-original.z64";
  assert.throws(() => parseRealRuntimeInput(relative));
  const replacement = input();
  replacement.packages[0]!.port_id = "unreviewed-other-game";
  assert.throws(() => parseRealRuntimeInput(replacement));
});

void test("mutable file accounting uses declared complete path components", () => {
  assert.equal(runtimeMutable(".runtime/wave/saved.dat", [".runtime"]), true);
  assert.equal(runtimeMutable("SAVES\\owned.bin", ["saves"]), true);
  assert.equal(runtimeMutable("general.json", ["general.json"]), true);
  assert.equal(runtimeMutable(".runtime-other/unknown.dll", [".runtime"]), false);
  assert.equal(runtimeMutable("general.json.bak", ["general.json"]), false);
  assert.equal(runtimeMutable("WaveRace64Recompiled.exe", [".runtime"]), false);
});
