import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readReviewFieldStyles } from "./desktop-review-presentation.mts";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

void test("catalog field presentation reaches the browser as executable JavaScript with both element arguments", async () => {
  const fields = [
    {
      width: "240px",
      paddingLeft: "12px",
      borderStyle: "solid",
      borderWidth: "1px",
      backgroundColor: "rgb(1, 2, 3)",
      color: "rgb(240, 240, 240)",
    },
    {
      width: "480px",
      paddingLeft: "16px",
      borderStyle: "solid",
      borderWidth: "2px",
      backgroundColor: "rgb(4, 5, 6)",
      color: "rgb(250, 250, 250)",
    },
  ];
  let calls = 0;
  const browser = {
    executeScript(script: (...args: unknown[]) => unknown, ...args: unknown[]) {
      calls++;
      assert.equal(args[0], fields[0]);
      assert.equal(args[1], fields[1]);
      const result: unknown = runInNewContext(`(${script.toString()})(...args)`, {
        args,
        getComputedStyle: (field: unknown) => field,
      });
      const transported: unknown = JSON.parse(JSON.stringify(result));
      return Promise.resolve(transported);
    },
  };
  const result: unknown = await Reflect.apply(readReviewFieldStyles, undefined, [
    browser,
    ...fields,
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(result, fields);
  for (const variant of [
    "original",
    "aliased",
    "wrong-export",
    "copied-reply",
    "wrong-command",
    "no-reply",
  ] as const) {
    const run = () =>
      runDesktopModuleFixture(
        new URL("./desktop-catalog-update-test.mts", import.meta.url),
        `
      const {WebDriver}=await import('selenium-webdriver');
      const failure={code:'owned style observation refused'};
      const fields=[{id:'public-key'},{id:'location'}];let reads=0,invocations=0,navigation=0;
      const forbiddenEffect=()=>{throw Error('Unexpected native or later presentation effect');};
      const fileSystem=await import('node:fs/promises');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(fileSystem).filter(([name])=>name!=='default')),writeFile:forbiddenEffect}});
      mock.module(new URL('./desktop-review-controls.mts',entry).href,{namedExports:{
        reviewControls:()=>({button:value=>value,click:async()=>{navigation++;}}),
        assertCompactReview:forbiddenEffect,assertPrimaryReviewAction:forbiddenEffect,captureAccessibilityReport:forbiddenEffect,
      }});
      let browser;
      mock.module(new URL('./desktop-review-presentation.mts',entry).href,{namedExports:{readReviewFieldStyles:async(observed,...selected)=>{
        assert.equal(observed,browser);assert.deepEqual(selected,fields);reads++;throw failure;
      }}});
      class ControlledBrowser extends WebDriver{
        wait(){return {};}
        findElement(locator){assert.ok(['catalog-public-key','catalog-update-location'].includes(locator.value));return fields[locator.value==='catalog-public-key'?0:1];}
      }
      browser=new ControlledBrowser();const artifacts=[];
      const {catalogUpdateScenario}=await import(entry);
      const variant=${JSON.stringify(variant)};
      const execute=()=>catalogUpdateScenario({browser,artifacts,output:'owned-output',
        scenario:async(name,action)=>{assert.equal(name,'native-catalog-update-dialog');return action();},
        invoke:async(command)=>{assert.equal(command,'get_catalog_status');invocations++;
          return {ok:true,value:variant==='copied-reply'?structuredClone(inertTransportReply.value):inertTransportReply?.value};},
      });
      if(['copied-reply','wrong-command','no-reply'].includes(variant)){
        await assert.rejects(execute,error=>error!==failure);assert.equal(reads,0);assert.equal(navigation,0);
      }else{
        await assert.rejects(execute,error=>error===failure);assert.equal(reads,1);assert.equal(navigation,3);
      }
      assert.equal(invocations,1);assert.deepEqual(artifacts,[]);
      `,
        variant === "aliased" || variant === "wrong-export"
          ? { exportName: "catalogUpdateScenario", variant }
          : undefined,
        variant === "no-reply"
          ? undefined
          : {
              command: variant === "wrong-command" ? "other-command" : "catalog_status",
              value: {},
            },
      );
    if (variant === "wrong-export") assert.throws(run);
    else run();
  }
});

void test("catalog transport is required only after its scenario is selected", () => {
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("./desktop-catalog-update-test.mts", import.meta.url),
        `
    const {catalogUpdateScenario}=await import(entry);
    let invoked=0;const selected=[];
    const context={browser:undefined,invoke:async()=>{invoked++;return {};},output:'/owned',artifacts:[]};
    await catalogUpdateScenario({...context,scenario:async(name)=>{selected.push(name);}});
    assert.deepEqual(selected,['native-catalog-update-dialog']);assert.equal(invoked,0);
    await assert.rejects(catalogUpdateScenario({...context,scenario:async(_name,run)=>run()}),
      /Selected catalog scenario requires its connected WebDriver transport/u);
    assert.equal(invoked,0);
  `,
        variant === "original" ? undefined : { exportName: "catalogUpdateScenario", variant },
      );
    if (variant === "wrong-export") assert.throws(execute, /native-catalog-update-dialog/u);
    else execute();
  }
});
