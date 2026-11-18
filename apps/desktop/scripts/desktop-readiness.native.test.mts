import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

const entry = new URL("./desktop-readiness-test.mts", import.meta.url);

void test("held-assessment cleanup records strict failures without replacing the primary error", () => {
  runDesktopModuleFixture(
    entry,
    `
    const {restoreActionHold}=await import(entry);
    const {isUntrustworthyProbeError}=await import(new URL('./desktop-owned-ipc-probe.mts',entry));
    const primary=Object.freeze(new Error('Original held-state wait expired'));
    const observed=[];
    const unused={restored:true,injected:0,originalAvailability:null};
    const browser={executeAsyncScript:async()=>unused};
    await assert.rejects(
      restoreActionHold(browser,'allowed',{primaryFailure:{error:primary},recordFailure:failure=>observed.push(failure)}),
      error=>error===primary,
    );
    assert.deepEqual(observed,[{
      message:'The held assessment must reach an actual native snapshot',restored:true,
      injected:0,originalAvailability:null,
    }]);
    assert.equal(isUntrustworthyProbeError(primary),false);
    await assert.rejects(restoreActionHold(browser,'allowed'),/The held assessment must reach an actual native snapshot/);
    for(const error of [undefined,null,false,0,'']) {
      await assert.rejects(
        restoreActionHold(browser,'allowed',{primaryFailure:{error}}),
        actual=>Object.is(actual,error),
      );
    }
    const unavailable=Object.freeze(new Error('Original wait before unavailable restoration'));
    const transport=new Error('Renderer restoration transport failed');
    const cleanup=[];
    await assert.rejects(
      restoreActionHold({executeAsyncScript:async()=>{throw transport;}},'allowed',{
        primaryFailure:{error:unavailable},recordFailure:failure=>cleanup.push(failure),
      }),
      error=>error===unavailable,
    );
    assert.equal(isUntrustworthyProbeError(unavailable),true);
    assert.deepEqual(cleanup,[{message:transport.message,restored:false}]);
    const valid={restored:true,injected:1,originalAvailability:'allowed'};
    assert.deepEqual(await restoreActionHold({executeAsyncScript:async()=>valid},'allowed'),valid);
    await assert.rejects(
      restoreActionHold({executeAsyncScript:async()=>valid},'waiting'),
      error=>error.code==='ERR_ASSERTION',
    );
  `,
  );
});

for (const kind of ["action", "readiness"] as const) {
  void test(`serialized ${kind} probe preserves fetch inputs, duplicate-row metadata and restoration`, () => {
    const program = `
      const subject=await import(entry);
      const {runReadinessFetchProbeOracle}=await import(new URL('../../../scripts/fixtures/native-fetch-probe-fixture.mts',entry));
      await runReadinessFetchProbeOracle(subject,${JSON.stringify(kind)});
    await runReadinessFetchProbeOracle(subject,${JSON.stringify(kind)},true);
    `;
    const exportName = kind === "action" ? "injectActionHold" : "injectReadinessOmission";
    runDesktopModuleFixture(entry, program);
    runDesktopModuleFixture(entry, program, { exportName, variant: "aliased" });
    assert.throws(
      () => runDesktopModuleFixture(entry, program, { exportName, variant: "wrong-export" }),
      (error: unknown) =>
        error instanceof assert.AssertionError &&
        error.message.includes("NATIVE_FETCH_PROBE_INSTALLATION"),
      "NATIVE_FETCH_PROBE_REMOVED_DEPENDENCY",
    );
  });
}

void test("actual readiness scenario installs its imported omission before observation and restores after failure", () => {
  const program = `
    const {runReadinessCallerProbe}=await import(new URL('../../../scripts/fixtures/native-fetch-probe-fixture.mts',entry));
    await runReadinessCallerProbe(entry,inertTransportReply);
  `;
  const replies = [
    { command: "port", value: { id: "opengoal-jak1", summary: "Owned readiness" } },
    { command: "status", value: { readiness: { launchable: true } } },
  ];
  runDesktopModuleFixture(entry, program, undefined, replies);
  runDesktopModuleFixture(
    entry,
    program,
    { exportName: "readinessScenario", variant: "aliased" },
    replies,
  );
  assert.throws(
    () =>
      runDesktopModuleFixture(
        entry,
        program,
        { exportName: "readinessScenario", variant: "wrong-export" },
        replies,
      ),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      error.message.includes("NATIVE_READINESS_CALLER_NOT_INVOKED"),
    "NATIVE_READINESS_REPLACED_ACTUAL_CALLER",
  );
});

void test("whole native module fixture retains exact transport pairs and refuses process and network work", () => {
  const program = `
    const {transportValue,transportValues}=await import(new URL('./transport-values.mts',entry));
    const pairs=Array.isArray(inertTransportReply)?inertTransportReply:[inertTransportReply];
    for(const pair of pairs)assert.equal(transportValue(pair.command,pair.value),pair.value);
    const denied=error=>error instanceof Error&&error.message==='Native process execution is forbidden in this fixture';
    assert.throws(()=>transportValue('undeclared',pairs[0].value),denied);
    assert.throws(()=>transportValue(pairs[0].command,{...pairs[0].value}),denied);
    if(pairs.length>1)assert.throws(()=>transportValue(pairs[0].command,pairs[1].value),denied);
    assert.throws(()=>transportValues(pairs[0].command,[pairs[0].value]),denied);
    const {spawnSync}=await import('node:child_process');
    assert.throws(()=>spawnSync(process.execPath,['--version']),denied);
    assert.throws(()=>process.kill(process.pid,0),denied);
    const networkProbe='data:text/javascript,'+encodeURIComponent("await fetch('data:text/plain,inert')");
    await assert.rejects(()=>import(networkProbe),error=>error instanceof Error&&error.message==='Uncontrolled fixture network work is forbidden');
  `;
  const port = { command: "port", value: { id: "owned" } };
  runDesktopModuleFixture(entry, program, undefined, port);
  runDesktopModuleFixture(entry, program, undefined, [
    port,
    { command: "status", value: { id: "other" } },
  ]);
});
