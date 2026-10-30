import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { parseRealRuntimeInput, runtimeMutable } from "./desktop-real-runtime-inputs.mts";
import { isRecord } from "./runtime-values.mts";
import { OwnedNativeSession } from "../apps/desktop/scripts/desktop-owned-native-session.mts";
import type { NativeProcessSnapshot } from "../apps/desktop/scripts/desktop-owned-native-session.mts";
import { runDesktopModuleFixture } from "./fixtures/desktop-module-fixture.mts";

void test("real runtime restarts retain distinct exclusive driver launch receipts", async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "portcove-runtime-launch-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const now = Date.now();
  const driverPath = path.join(output, "selected-driver.exe");
  const artifacts: string[] = [];
  const ownedSession = new OwnedNativeSession();
  const filetime = (milliseconds: number) =>
    String((BigInt(milliseconds) + 11_644_473_600_000n) * 10_000n);
  let current: NativeProcessSnapshot["driver"] = {
    pid: 101,
    path: driverPath,
    started_filetime: filetime(now),
  };
  const capture = (pid = current.pid) =>
    ownedSession.captureDriverLaunch({
      pid,
      executable: driverPath,
      output,
      name: "real-prepared-runtime",
      launchStarted: now,
      artifacts,
      now: () => now,
      observe: (mode, snapshot) => {
        assert.equal(mode, "SnapshotDriver");
        const captured = {
          captured_at: new Date(now).toISOString(),
          driver: current,
          application_pid: null,
          processes: [],
        };
        writeFileSync(snapshot, JSON.stringify(captured), { flag: "wx" });
        return captured;
      },
    });
  const launchedPids = [101, 202, 303, 101];
  for (const pid of launchedPids) {
    ownedSession.beginLaunch();
    current = { ...current, pid };
    assert.doesNotThrow(() => capture(), "NATIVE_DRIVER_SEQUENCE_CUSTODY");
  }
  assert.equal(new Set(artifacts).size, 4, "NATIVE_DRIVER_RECEIPT_INVENTORY");
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
  assert.deepEqual(originalDriver, current, "NATIVE_DRIVER_CUSTODY_BINDING");
  // Collide with the next immutable receipt without reaching into private state.
  const collision = path.join(output, "real-prepared-runtime-driver-startup-5-303.json");
  writeFileSync(collision, "earlier receipt", { flag: "wx" });
  current = { ...current, pid: 303 };
  assert.throws(() => capture(), { code: "EEXIST" });
  assert.deepEqual(artifacts, originalArtifacts);
  assert.equal(ownedSession.driver, originalDriver);
  assert.equal(await readFile(collision, "utf8"), "earlier receipt");
  assert.deepEqual(
    await Promise.all(artifacts.map((file) => readFile(file, "utf8"))),
    originalBytes,
  );
  capture();
  assert.equal(path.basename(artifacts.at(-1)!), "real-prepared-runtime-driver-startup-6-303.json");
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

void test("ordinary game close retains its real request when the positive exit wait fails", () => {
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("../apps/desktop/scripts/desktop-real-runtime-test.mts", import.meta.url),
        `
      const {requestRealRuntimeClose}=await import(entry);
      const requested={application_pid:42,main_window_handle:'101',main_window_title:'Owned game',message_sent:true};
      const exited={exited_at:'2026-10-30T00:00:00Z',observed_processes:2,wait_ms:4};
      for(const phase of ['ready','request','write','wait']) for(const failure of [new Error('owned refusal'),undefined,null,false,0,'']) {
        const calls=[],route={},artifacts=[],requestFile='/owned/request.json';
        const native=(mode,snapshot,extra)=>{
          assert.equal(snapshot,'/owned/identity.json');calls.push(mode);
          if(mode==='RequestClose'){
            assert.deepEqual(extra,['-ApplicationPath','/owned/game.exe']);
            if(phase==='request')throw failure;return requested;
          }
          assert.equal(mode,'Wait');assert.equal(extra,undefined);
          assert.equal(route.ordinary_game_close.requested,requested);
          assert.deepEqual(artifacts,[requestFile]);
          if(phase==='wait')throw failure;return exited;
        };
        const write=async(file,bytes,options)=>{
          calls.push('write');assert.equal(file,requestFile);assert.deepEqual(options,{flag:'wx'});
          assert.deepEqual(JSON.parse(bytes),requested);
          assert.equal(route.ordinary_game_close.requested,requested);
          assert.deepEqual(artifacts,[]);if(phase==='write')throw failure;
        };
        const action=requestRealRuntimeClose({native,closeFile:'/owned/identity.json',executable:'/owned/game.exe',requestFile,route,artifacts,write});
        if(phase==='ready'){
          await action;assert.deepEqual(calls,['RequestClose','write','Wait'],'NATIVE_REAL_RUNTIME_CLOSE_ORDER');
          assert.equal(route.ordinary_game_close.requested,requested);assert.equal(route.ordinary_game_close.exited,exited);
        }else{
          await assert.rejects(action,error=>error===failure);
          assert.deepEqual(calls,phase==='request'?['RequestClose']:phase==='write'?['RequestClose','write']:['RequestClose','write','Wait']);
          assert.equal(route.ordinary_game_close?.requested,phase==='request'?undefined:requested);
          assert.equal(route.ordinary_game_close?.exited,undefined);
          assert.deepEqual(artifacts,phase==='wait'?[requestFile]:[]);
        }
      }
      `,
        variant === "original" ? undefined : { exportName: "requestRealRuntimeClose", variant },
      );
    if (variant === "wrong-export")
      assert.throws(
        execute,
        (error) =>
          error instanceof assert.AssertionError &&
          error.actual === 1 &&
          /ERR_ASSERTION/u.test(error.message) &&
          /NATIVE_REAL_RUNTIME_CLOSE_ORDER/u.test(error.message),
      );
    else execute();
  }
});

void test("driver launch rejects foreign identity and birth observations before binding custody", () => {
  const session = new OwnedNativeSession();
  const original = { pid: 1, path: path.resolve("prior-driver.exe"), started_filetime: "100" };
  const artifacts: string[] = [];
  const now = Date.now(),
    executable = path.resolve("selected-driver.exe");
  const ticks = (milliseconds: number) =>
    String((BigInt(milliseconds) + 11_644_473_600_000n) * 10_000n);
  let sequence = 0;
  session.driver = original;
  for (const fault of ["pid", "path", "early", "future", "malformed", "observer"] as const) {
    const failure = new Error(fault);
    const action = () =>
      session.captureDriverLaunch({
        pid: 42,
        executable,
        output: os.tmpdir(),
        name: "owned",
        launchStarted: now,
        artifacts,
        now: () => now,
        observe: (mode, file) => {
          assert.equal(mode, "SnapshotDriver");
          assert.equal(path.basename(file), `owned-driver-startup-${++sequence}-42.json`);
          if (fault === "observer") throw failure;
          return {
            captured_at: "observed",
            application_pid: null,
            processes: [],
            driver: {
              pid: fault === "pid" ? 43 : 42,
              path: fault === "path" ? path.resolve("foreign.exe") : executable,
              started_filetime:
                fault === "malformed"
                  ? "invalid"
                  : ticks(now + (fault === "early" ? -2 : fault === "future" ? 1 : 0)),
            },
          };
        },
      });
    if (fault === "observer") assert.throws(action, (error) => error === failure);
    else assert.throws(action, "NATIVE_DRIVER_IDENTITY_GUARD:" + fault);
    assert.equal(session.driver, original, "NATIVE_DRIVER_IDENTITY_PRESERVED");
    assert.deepEqual(artifacts, []);
  }
});
