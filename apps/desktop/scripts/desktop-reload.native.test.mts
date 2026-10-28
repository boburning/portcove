import assert from "node:assert/strict";
import test from "node:test";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";

void test("serialized reload reads bind each bootstrap generation and stop at the first rejected batch", () => {
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("./desktop-reload-test.mts", import.meta.url),
        `
    import path from 'node:path';import {runInNewContext} from 'node:vm';
    const object=value=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value;};
    let reports=[];
    mock.module('node:fs/promises',{namedExports:{writeFile:async(file,bytes,options)=>{
      assert.equal(file,path.join('owned-output','reload-observations.json'));
      assert.deepEqual(options,{flag:'wx'});reports.push(JSON.parse(bytes));
    }}});
    const {reloadScenario}=await import(entry);
    for(const mode of ['success','commands','bootstrap-reject','bootstrap-malformed']){
      const failure=mode!=='success',bootstrapFailure=mode.startsWith('bootstrap-');
      let refreshes=0;const calls=[],artifacts=[];reports=[];
      const original={code:'owned fixture rejection',detail:'retained'};
      const browser={
        navigate:()=>({refresh:async()=>{refreshes++;}}),
        findElements:async()=>[],
        wait:async(predicate)=>{if(typeof predicate==='function')assert.equal(await predicate(),true);},
        executeAsyncScript:(callback,commands)=>new Promise((done,reject)=>{
          assert.equal(typeof callback,'function');
          const window={__TAURI_INTERNALS__:{invoke:async(command,args)=>{
            calls.push({command,args});
            if(command==='get_bootstrap_status'){
              if(mode==='bootstrap-reject')throw original;
              if(mode==='bootstrap-malformed')return {};
              return {generation:refreshes};
            }
            if(mode==='commands'&&command==='get_doctor_report')throw original;
            return {owned:true};
          }}};
          try{runInNewContext('('+callback.toString()+')(commands,done)',{window,commands,done},{timeout:1000});}
          catch(error){reject(error);}
        }),
        executeScript:async(callback)=>{
          assert.equal(typeof callback,'function');
          const value=runInNewContext('('+callback.toString()+')()',
            {document:{querySelectorAll:()=>[]}},{timeout:1000});
          return JSON.parse(JSON.stringify(value));
        },
      };
      const result=reloadScenario({browser,cycles:2,output:'owned-output',artifacts,
        scenario:async(_name,action)=>action()});
      if(failure)await assert.rejects(result);else await result;
      assert.equal(refreshes,failure?1:2);
      assert.deepEqual(calls.map(call=>call.command),bootstrapFailure?['get_bootstrap_status']:
        Array.from({length:refreshes},()=>['get_bootstrap_status','get_workspace_snapshot','get_doctor_report']).flat());
      for(const [index,call] of calls.entries()){
        if(index%3===0)assert.equal(call.args,undefined);
        else assert.equal(JSON.stringify(call.args),JSON.stringify({generation:Math.floor(index/3)+1}));
      }
      assert.deepEqual(artifacts,[path.join('owned-output','reload-observations.json')]);
      assert.equal(reports.length,1);const observations=reports[0];
      assert.ok(Array.isArray(observations));assert.equal(observations.length,refreshes);
      if(failure){
        const commands=object(observations[0]).commands;assert.ok(Array.isArray(commands));
        const failed=object(commands[bootstrapFailure?0:1]);assert.equal(failed.ok,false);
        assert.equal(failed.command,bootstrapFailure?'get_bootstrap_status':'get_doctor_report');
        if(mode==='bootstrap-malformed'){
          const message=object(failed.error).message;assert.equal(typeof message,'string');
          assert.match(message,/Bootstrap generation unavailable/);
        }else assert.deepEqual(failed.error,original);
        assert.equal(object(observations[0]).completed_at,undefined);
      }else assert.ok(observations.every(value=>typeof object(value).completed_at==='string'));
    }
  `,
        variant === "original" ? undefined : { exportName: "reloadScenario", variant },
      );
    if (variant === "wrong-export") assert.throws(execute, /0 !== 2/u);
    else execute();
  }
});
