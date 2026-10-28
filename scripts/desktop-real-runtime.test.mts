import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { parseRealRuntimeInput, runtimeMutable } from "./desktop-real-runtime-inputs.mts";
import { isRecord } from "./runtime-values.mts";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";

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
    driverStartupSequence: 0,
    driverPath,
    output,
    artifacts,
    ownedSession,
    cleanupName: "real-prepared-runtime",
    hostInterruptionSession: false,
    hostPublicationSession: false,
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
  const launchedPids = [101, 202, 303, 101];
  for (const pid of launchedPids) {
    context.driver = { pid };
    capture(now);
  }
  assert.equal(new Set(artifacts).size, 4);
  assert.deepEqual(
    artifacts.map((file) => path.basename(file)),
    launchedPids.map(
      (pid, index) => `real-prepared-runtime-driver-startup-${index + 1}-${pid}.json`,
    ),
  );
  const originalBytes = await Promise.all(artifacts.map((file) => readFile(file, "utf8")));
  assert.deepEqual(
    originalBytes.map((bytes) => {
      const value: unknown = JSON.parse(bytes);
      assert.ok(isRecord(value) && isRecord(value.driver));
      return value.driver.pid;
    }),
    launchedPids,
  );
  const originalArtifacts = [...artifacts],
    originalDriver = ownedSession.driver;
  assert.deepEqual(originalDriver, {
    pid: 101,
    path: driverPath,
    started_filetime: String((BigInt(now) + 11_644_473_600_000n) * 10_000n),
  });
  // Deliberately replay a previously used sequence/PID to retain the exclusive
  // write refusal, independently of a legitimate later launch reusing a PID.
  context.driverStartupSequence = 2;
  context.driver = { pid: 303 };
  assert.throws(() => capture(now), { code: "EEXIST" });
  assert.deepEqual(artifacts, originalArtifacts);
  assert.equal(ownedSession.driver, originalDriver);
  assert.deepEqual(
    await Promise.all(artifacts.map((file) => readFile(file, "utf8"))),
    originalBytes,
  );
});

void test("real runtime review waits for the actual visible enabled action after preview", async () => {
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("../apps/desktop/scripts/desktop-real-runtime-test.mts", import.meta.url),
        `
{
      const {Key}=await import('selenium-webdriver');
      Object.assign(Key,{CONTROL:'Control',BACK_SPACE:'Backspace',chord:(...keys)=>keys.join('+')});
      const reports=[];
      const fileSystem=await import('node:fs/promises');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(fileSystem).filter(([name])=>name!=='default')),
        writeFile:async(file,bytes,options)=>{assert.deepEqual(options,{flag:'wx'});reports.push({file,bytes});}}});
      const evidenceUrl=new URL('../../../scripts/development-evidence.mts',entry).href;
      const evidence=await import(evidenceUrl);
      mock.module(evidenceUrl,{namedExports:{...evidence,fileIdentity:async(file)=>{assert.equal(file,'/owned/app');return {path:file,bytes:1,sha256:'a'.repeat(64)};}}});
      let navigations=0;
      mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{selectCatalogPort:async(_browser,id)=>{assert.equal(id,'owned-port');navigations++;}}});
      const {waitForRealRuntimeReview,realRuntimeScenario}=await import(entry);
      let controls=[],matches=[],poll,visible=true;
      const dialog={isDisplayed:async()=>visible,findElements:async(selector)=>{assert.equal(selector.value,'.//button[normalize-space(.)="Use this installation"]');return controls;}};
      const browser={findElements:async(selector)=>{assert.equal(selector.value,'[role="dialog"][aria-describedby="external-register-description"]');return matches;},
        wait:async(predicate,timeout)=>{assert.equal(timeout,15000);poll=predicate;return predicate();}};
      assert.equal(await waitForRealRuntimeReview(browser,'register','Use this installation'),false);
      assert.equal(typeof poll,'function');
      matches=[dialog];assert.equal(await poll(),false);
      visible=false;assert.equal(await poll(),false);visible=true;
      controls=[{isDisplayed:async()=>false,isEnabled:async()=>true}];assert.equal(await poll(),false);
      controls=[{isDisplayed:async()=>true,isEnabled:async()=>false}];assert.equal(await poll(),false);
      const control={isDisplayed:async()=>true,isEnabled:async()=>true};controls=[control];
      const ready=await poll();assert.equal(ready.dialog,dialog);assert.equal(ready.control,control);
      controls=[control,control];await assert.rejects(poll,/must be unique/);
      matches=[dialog,dialog];await assert.rejects(poll);
      // The real entrypoint must reach this same unavailable action and retain
      // its exact refusal before registration, IPC or native process execution.
      const originalFailure={code:'owned review remains disabled'};
      controls=[{isDisplayed:async()=>true,isEnabled:async()=>false}];matches=[dialog];
      const instruction='fixture.zip v1 game.exe It does not copy, update, back up, or delete these files.';
      const element={click:async()=>{},sendKeys:async()=>{},getText:async()=>instruction};
      const actualBrowser={...browser,findElement:()=>element,takeScreenshot:async()=>'',
        wait:async(condition,timeout)=>{
          assert.equal(timeout,15000);
          if(typeof condition!=='function')return element;
          assert.equal(await condition(),false);throw originalFailure;
        }};
      const forbiddenEffect=()=>{throw Error('Unexpected native or mutation effect');};
      const artifacts=[];
      await assert.rejects(realRuntimeScenario({browser:actualBrowser,application:'/owned/app',
        cli:'/owned/cli',library:'/owned/library',output:'/owned/output',artifacts,
        fixture:{packages:[{port:{id:'owned-port',name:'Owned game'},spec:{archive_name:'fixture.zip',version:'v1',executable:'game.exe'},directory:'/owned/runtime'}]},
        invoke:forbiddenEffect,confirmNative:forbiddenEffect,restartApplication:forbiddenEffect,
        selectPicker:async(name,directory)=>{assert.equal(name,'owned-port-dismiss');assert.equal(directory,'/owned/runtime');return {selected:true,supplied_directory:true};},
      }),error=>error===originalFailure);
      assert.equal(navigations,1);assert.equal(reports.length,2);
      const path=(await import('node:path')).default;
      assert.deepEqual(reports.map(report=>report.file),[path.join('/owned/output','owned-port-manual-return.png'),path.join('/owned/output','real-runtime-desktop.json')]);
      assert.deepEqual(artifacts,reports.map(report=>report.file));
      const report=JSON.parse(reports.at(-1).bytes);assert.equal(report.routes.length,1);
      assert.equal(report.routes[0].registered,undefined);
      }
      `,
        variant === "original" ? undefined : { exportName: "waitForRealRuntimeReview", variant },
      );
    if (variant === "wrong-export") assert.throws(execute);
    else execute();
  }
});

function input() {
  return {
    format_version: 2,
    packages: ["wave-race-64-racewave46", "dkc3-recomp"].map((port_id) => ({
      port_id,
      archive: path.join(os.tmpdir(), `${port_id}.zip`),
      source: path.join(os.tmpdir(), `${port_id}-owned-original.bin`),
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
  relative.packages[0]!.source = "relative-original.z64";
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

void test("ordinary game close retains its real request when the positive exit wait fails", async () => {
  const source = await readFile(
    new URL("../apps/desktop/scripts/desktop-real-runtime-test.mts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('    const requested = native("RequestClose", closeFile,');
  const end = source.indexOf("    const terminal = await browser.wait(", start);
  assert.ok(start >= 0 && end > start);
  const requested = {
    application_pid: 42,
    main_window_handle: "101",
    main_window_title: "Owned game",
    message_sent: true,
  };
  const failure = new Error("owned process did not exit");
  const route: Record<string, unknown> = {};
  const artifacts: string[] = [];
  const writes: unknown[] = [];
  const execute = runInNewContext(
    `(async () => { ${stripTypeScriptTypes(source.slice(start, end))} })`,
    {
      native: (mode: string) => {
        if (mode === "RequestClose") return requested;
        assert.equal(mode, "Wait");
        throw failure;
      },
      closeFile: "/owned/identity.json",
      executable: "/owned/game.exe",
      route,
      path,
      output: "/owned/output",
      port: { id: "pilot" },
      writeFile: async (file: string, bytes: string, options: unknown) => {
        const value: unknown = JSON.parse(bytes);
        const parsedOptions: unknown = JSON.parse(JSON.stringify(options));
        writes.push({ file, value, options: parsedOptions });
      },
      artifacts,
    },
  ) as () => Promise<unknown>;
  await assert.rejects(execute(), (error) => error === failure);
  assert.equal((route.ordinary_game_close as { requested: unknown }).requested, requested);
  assert.deepEqual(writes, [
    {
      file: path.join("/owned/output", "pilot-ordinary-close-request.json"),
      value: requested,
      options: { flag: "wx" },
    },
  ]);
  assert.deepEqual(artifacts, [path.join("/owned/output", "pilot-ordinary-close-request.json")]);
});
