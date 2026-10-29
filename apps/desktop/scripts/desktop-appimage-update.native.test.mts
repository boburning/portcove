import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAppImageProcessObservations,
  readAppImageProcessIdentity,
  observeHealthyAppImageRestart,
  waitForHealthyAppImageRestart,
} from "./desktop-installed-update-harness.mts";

void test("AppImage healthy reconciliation requires actual payload absence, not an inspection failure", async () => {
  for (const code of ["ENOENT", "EACCES", "EIO", "ENOTDIR"]) {
    const failure = Object.assign(new Error(code), { code });
    const result = waitForHealthyAppImageRestart(
      {
        app: "/owned/Portcove.AppImage",
        candidateSha: "a".repeat(64),
        staging: "/owned/staging",
        stageMarker: "/owned/stage.json",
        stagedPayload: "/owned/staging/candidate.payload",
      },
      {
        read: async (file) =>
          file.endsWith("stage.json")
            ? { stage: "Tauri setup", process_id: 42 }
            : { intent: null, phase: "reconciled" },
        hash: async () => ({ sha256: "a".repeat(64) }),
        inspect: () => Promise.reject(failure),
        poll: async (predicate, label, budget) => {
          assert.equal(label, "renderer-driven restart and healthy-startup reconciliation");
          assert.equal(budget, 90_000);
          const value = await predicate();
          assert.ok(value);
          return value;
        },
      },
    );
    if (code === "ENOENT") {
      const value = await result;
      assert.ok(value !== null && typeof value === "object" && "marker" in value);
      assert.equal(
        JSON.stringify(value.marker),
        JSON.stringify({ stage: "Tauri setup", process_id: 42 }),
      );
    } else
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => error === failure,
      );
  }
});

void test("AppImage procfs observation rejects unexpected failures and omits zombies", async () => {
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[19] = "123";
  const raw = `42 (owned command) ${fields.join(" ")}`;
  for (const state of ["S", "Z"]) {
    const result = readAppImageProcessIdentity(42, async (file) =>
      file.endsWith("/stat")
        ? raw.replace(") S ", `) ${state} `)
        : "/owned/app\0--portcove-apply-update\0",
    );
    const observed = await result;
    if (state === "Z") assert.equal(observed, null);
    else
      assert.equal(
        JSON.stringify(observed),
        JSON.stringify({
          pid: 42,
          start_ticks: "123",
          command: "/owned/app --portcove-apply-update ",
        }),
      );
  }
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EIO"]) {
    const failure = Object.assign(new Error(code), { code });
    const result = readAppImageProcessIdentity(42, () => Promise.reject(failure));
    if (code === "ENOENT" || code === "ESRCH") assert.equal(await result, null);
    else
      await assert.rejects(
        async () => {
          await result;
        },
        (error: unknown) => error === failure,
      );
  }
});

void test("AppImage relaunch environment and start ticks must agree before cleanup authority is returned", async () => {
  const app = "/owned/Portcove.AppImage",
    stageMarker = "/owned/stage.json",
    relaunchMarker = "/owned/relaunch.json";
  const environment = [
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE=${stageMarker}`,
    `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS=${relaunchMarker}`,
    "PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT=after-reconciliation",
  ];
  for (const [changedIdentity, missingEnvironment] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const) {
    let reads = 0;
    const observers = createAppImageProcessObservations(
      { app, stageMarker, relaunchMarker, helperMarker: "/owned/helper.json" },
      {
        identify: async () => ({
          pid: 42,
          start_ticks: changedIdentity && reads++ > 0 ? "replacement" : "123",
          command: app,
        }),
        read: async () => (missingEnvironment ? environment.slice(1) : environment).join("\0"),
      },
    );
    const result = observers.verifiedRelaunchIdentity({
      schema_version: 1,
      process_id: 42,
      executable: app,
    });
    if (changedIdentity || missingEnvironment)
      await assert.rejects(async () => {
        await result;
      });
    else {
      const identity = await result;
      assert.ok(identity !== null && typeof identity === "object" && "start_ticks" in identity);
      assert.equal(identity.start_ticks, "123");
    }
  }
});

void test("AppImage environment-read races preserve disappearance, replacement and original failure", async () => {
  const failure = Object.assign(new Error("controlled environment read"), { code: "EACCES" });
  const marker = { schema_version: 1 as const, process_id: 42, executable: "/owned/app" };
  for (const after of ["unchanged", "replaced", "disappeared"] as const) {
    let reads = 0;
    const observers = createAppImageProcessObservations(
      {
        app: marker.executable,
        stageMarker: "/owned/stage",
        relaunchMarker: "/owned/relaunch",
        helperMarker: "/owned/helper",
      },
      {
        read: () => Promise.reject(failure),
        identify: async () => {
          const initial = reads++ === 0;
          return !initial && after === "disappeared"
            ? null
            : {
                pid: 42,
                start_ticks: !initial && after === "replaced" ? "replacement" : "original",
                command: marker.executable,
              };
        },
      },
    );
    const observed = observers.verifiedRelaunchIdentity(marker);
    if (after === "disappeared") assert.equal(await observed, null);
    else
      await assert.rejects(
        observed,
        after === "replaced"
          ? /identity changed while reading/u
          : (error: unknown) => error === failure,
      );
  }
});

void test("AppImage helper and relaunch observations retain distinct marker and command gates", async () => {
  const config = {
    app: "/owned/app",
    stageMarker: "/owned/stage",
    relaunchMarker: "/owned/relaunch",
    helperMarker: "/owned/helper",
  };
  const marker = { schema_version: 1 as const, process_id: 42, executable: config.app };
  const helperEnvironment = `PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_HELPER_PROCESS=${config.helperMarker}`;
  for (const [command, environment, accepted] of [
    ["/owned/app --portcove-apply-update", helperEnvironment, true],
    ["/owned/app", helperEnvironment, false],
    ["/owned/app --portcove-apply-update", "foreign", false],
  ] as const) {
    const observers = createAppImageProcessObservations(config, {
      identify: async () => ({ pid: 42, start_ticks: "123", command }),
      read: async () => environment,
    });
    if (accepted)
      assert.equal((await observers.verifiedHelperIdentity(marker))?.start_ticks, "123");
    else await assert.rejects(observers.verifiedHelperIdentity(marker));
    await assert.rejects(
      observers.verifiedRelaunchIdentity(marker),
      /exact qualification identity/u,
    );
    await assert.rejects(
      observers.verifiedRelaunchIdentity({ ...marker, executable: "/foreign/app" }),
      /executable changed/u,
    );
  }
});

void test("AppImage healthy observation refuses incomplete stage, hash, intent and payload gates", async () => {
  for (const gate of ["stage", "hash", "intent", "payload"] as const) {
    const result = await observeHealthyAppImageRestart(
      {
        app: "/owned/app",
        candidateSha: "a".repeat(64),
        staging: "/owned/staging",
        stageMarker: "/owned/stage.json",
        stagedPayload: "/owned/candidate",
      },
      {
        read: async (file) =>
          file.endsWith("stage.json")
            ? { stage: gate === "stage" ? "starting" : "Tauri setup", process_id: 42 }
            : { intent: gate === "intent" ? "pending" : null, phase: "reconciled" },
        hash: async () => ({ sha256: (gate === "hash" ? "b" : "a").repeat(64) }),
        inspect: async () => {
          if (gate !== "payload") throw Object.assign(new Error("absent"), { code: "ENOENT" });
        },
      },
    );
    assert.equal(result, null, gate);
  }
});

void test("actual AppImage observers tolerate refactors and detect removed identity and absence guards", () => {
  const module = new URL("./desktop-installed-update-harness.mts", import.meta.url).href;
  for (const variant of ["original", "renamed-reordered", "removed-identity", "removed-absence"]) {
    const program = `
      import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
      const module=${JSON.stringify(module)},variant=${JSON.stringify(variant)};
      registerHooks({load(url,context,next){const loaded=next(url,context);if(url!==module)return loaded;
        let source=String(loaded.source);
        if(variant==='renamed-reordered') {
          const start=source.indexOf('export async function readAppImageProcessIdentity(');
          const end=source.indexOf('export function createAppImageProcessObservations(',start);
          assert.ok(start>=0 && end>start);const declaration=source.slice(start,end);
          source=source.slice(0,start)+source.slice(end)+'\\n'+declaration;
          source=source.replaceAll('readRelaunchEnvironment','$environmentObservation');
        }
        if(variant==='removed-identity') {
          const gate='assert.equal(after.start_ticks, identity.start_ticks, "Relaunched process identity changed");';
          assert.ok(source.includes(gate));source=source.replace(gate,'');
        }
        if(variant==='removed-absence') {
          const gate='if (errorCode(error) !== "ENOENT") throw error;';
          assert.ok(source.includes(gate));source=source.replace(gate,'');
        }
        return {...loaded,source};
      }});
      const {createAppImageProcessObservations,observeHealthyAppImageRestart}=await import(module);
      const config={app:'/owned/app',stageMarker:'/owned/stage',relaunchMarker:'/owned/relaunch',helperMarker:'/owned/helper'};
      let reads=0;
      const observers=createAppImageProcessObservations(config,{
        identify:async()=>({pid:42,start_ticks:reads++?'replacement':'original',command:config.app}),
        read:async()=>['PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_STAGE='+config.stageMarker,
          'PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_RELAUNCH_PROCESS='+config.relaunchMarker,
          'PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_EXIT=after-reconciliation'].join('\\0'),
      });
      await assert.rejects(observers.verifiedRelaunchIdentity({schema_version:1,process_id:42,executable:config.app}),/identity changed/);
      const failure=Object.assign(new Error('inspection refused'),{code:'EACCES'});
      await assert.rejects(observeHealthyAppImageRestart({...config,candidateSha:'a'.repeat(64),staging:'/owned/staging',stagedPayload:'/owned/payload'},
        {read:async(file)=>file===config.stageMarker?{stage:'Tauri setup',process_id:42}:{intent:null,phase:'reconciled'},
          hash:async()=>({sha256:'a'.repeat(64)}),inspect:()=>Promise.reject(failure)}),error=>error===failure);
      console.log('PASS AppImage observer contract');
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    if (variant === "original" || variant === "renamed-reordered") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PASS AppImage observer contract/u);
    } else {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Missing expected rejection/u);
    }
  }
});

void test("actual AppImage entrypoint consumes its observation and reconciliation helpers", async (t) => {
  const entry = new URL("./desktop-appimage-update-test.mts", import.meta.url).href;
  const module = (name: string) => new URL(name, import.meta.url).href;
  for (const variant of ["original", "aliased", "bypassed-factory", "bypassed-restart"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pcv-appimage-caller-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const program = `
      import assert from 'node:assert/strict';import {mock} from 'node:test';
      import {registerHooks} from 'node:module';import path from 'node:path';
      const entry=${JSON.stringify(entry)},root=${JSON.stringify(root)},variant=${JSON.stringify(variant)};
      const app=path.join(root,'Portcove.AppImage'),staging=path.join(root,'staging');
      const stageMarker=path.join(root,'stage.json'),relaunchMarker=path.join(root,'relaunch.json'),helperMarker=path.join(root,'helper.json');
      const sentinel='controlled reconciliation observation reached';
      let factoryCalls=0,restartCalls=0,settled=false,kills=0;
      const observers=()=>({procIdentity:async(pid)=>settled?null:{pid,start_ticks:'123',command:pid===202?'/owned/portcove-desktop':'/owned/driver'},
        verifiedRelaunchIdentity:async()=>null,verifiedHelperIdentity:async()=>null});
      globalThis.bypassFactory=observers;
      globalThis.bypassRestart=async()=>{settled=true;return {marker:{stage:'Tauri setup',process_id:303},apply_phase:'reconciled',stable_sha256:'a'.repeat(64)};};
      process.kill=()=>{kills++;throw new Error('Native signalling is forbidden by this control');};
      mock.module(${JSON.stringify(module("./desktop-installed-update-harness.mts"))},{namedExports:{
        createAppImageProcessObservations:(config)=>{assert.deepEqual(config,{app,stageMarker,relaunchMarker,helperMarker});factoryCalls++;return observers();},
        waitForHealthyAppImageRestart:async(config)=>{assert.deepEqual(config,{app,candidateSha:'a'.repeat(64),staging,stageMarker,stagedPayload:path.join(staging,'candidate.payload')});restartCalls++;settled=true;throw new Error(sentinel);},
        hashFile:async()=>({sha256:'b'.repeat(64),bytes:1}),
        startInstalledUpdateDriver:()=>({driver:{pid:101,exitCode:null},log:'controlled'}),
        awaitInstalledUpdateDriver:async(driver,identify)=>identify(driver.pid),
        connectInstalledUpdateDriver:async()=>({takeScreenshot:async()=>'',findElement:()=>({click:async()=>{}}),quit:async()=>{}}),
        verifyInstalledUpdateStaging:async()=>({}),
        readJson:async(file)=>{assert.ok(file===helperMarker||file===relaunchMarker);return {schema_version:1,process_id:303,executable:app};},
        waitFor:async(predicate)=>predicate(),
        recordInstalledUpdateFailure:async(report,error)=>{report.phase='failed';report.failure=error.message;},
      }});
      mock.module(${JSON.stringify(module("./desktop-application-update-journey.mts"))},{namedExports:{driveInstalledUpdateToRestart:async()=>({}),driveInstalledStableWaiting:async()=>{throw new Error('Historical waiting must not run in the ordinary entrypoint control');}}});
      mock.module(${JSON.stringify(module("./desktop-linux-webkit-inspector.mts"))},{namedExports:{loadedWebKitLibraries:async()=>({process:{start_ticks:'123'}})}});
      mock.module('node:child_process',{namedExports:{execFileSync:(command,args)=>{
        if(command==='git'){assert.deepEqual(args,['rev-parse','HEAD']);return 'a'.repeat(40);}
        assert.equal(command,'ps');assert.deepEqual(args,['-eo','pid=,ppid=']);return '101 1\\n202 101\\n';
      }}});
      registerHooks({resolve(specifier,context,next){
        if(specifier==='selenium-webdriver')return {url:'data:text/javascript,export const By={xpath:value=>value};export const until={}',shortCircuit:true};
        if(!specifier.startsWith('node:')&&!specifier.startsWith('.')&&!specifier.startsWith('file:')&&!specifier.startsWith('data:'))throw new Error('Unexpected package import');
        return next(specifier,context);
      },load(url,context,next){const loaded=next(url,context);if(url!==entry)return loaded;let source=String(loaded.source);
        const factory='createAppImageProcessObservations({ app, stageMarker, relaunchMarker, helperMarker })';
        const restart='await waitForHealthyAppImageRestart({';
        if(variant==='bypassed-factory'){assert.ok(source.includes(factory));source=source.replace(factory,'globalThis.bypassFactory()');}
        if(variant==='bypassed-restart'){assert.ok(source.includes(restart));source=source.replace(restart,'await globalThis.bypassRestart({');}
        if(variant==='aliased'){
          source=source.replace('  createAppImageProcessObservations,','  createAppImageProcessObservations as $observations,').replace(factory,'$observations({ app, stageMarker, relaunchMarker, helperMarker })');
          source=source.replace('  waitForHealthyAppImageRestart,','  waitForHealthyAppImageRestart as $restart,').replace(restart,'await $restart({');
        }
        return {...loaded,source};
      }});
      const options={app,driver:path.join(root,'driver'),'native-driver':path.join(root,'native-driver'),output:path.join(root,'output'),staging,
        'stage-marker':stageMarker,'relaunch-process-marker':relaunchMarker,'helper-process-marker':helperMarker,'candidate-sha':'a'.repeat(64),'candidate-version':'1.0.0'};
      process.argv=[process.execPath,new URL(entry).pathname,...Object.entries(options).flatMap(([key,value])=>['--'+key,value])];
      const timeout=globalThis.setTimeout;globalThis.setTimeout=(callback,delay,...args)=>timeout(callback,0,...args);
      await assert.rejects(import(entry),new RegExp(sentinel));
      assert.equal(factoryCalls,1,'Actual observation factory must be consumed');
      assert.equal(restartCalls,1,'Actual healthy-restart helper must be consumed');
      assert.equal(kills,0,'The control may not signal a native process');
      process.exitCode=0;console.log('PASS actual AppImage entrypoint');
    `;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const driver = path.join(root, "driver.mjs");
    await writeFile(driver, program);
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", driver], {
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    if (variant === "original" || variant === "aliased") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PASS actual AppImage entrypoint/u);
    } else {
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /Actual observation factory must be consumed|Missing expected rejection/u,
      );
    }
  }
});
