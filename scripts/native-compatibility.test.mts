import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fixtureModulePolicySource } from "./fixtures/desktop-module-fixture.mts";

void test("native compatibility retains exact primary and cleanup failures while writing evidence", () => {
  const entry = new URL("../apps/desktop/test/native-compatibility.mts", import.meta.url);
  for (const variant of ["original", "format", "removed-entrypoint"] as const) {
    for (const phase of ["primary", "cleanup"] as const) {
      for (let index = 0; index < 6; index++) {
        // Each failure gets its own child: rejected ESM imports are cached.
        const environment: NodeJS.ProcessEnv = {};
        for (const name of [
          "PATH",
          "Path",
          "SystemRoot",
          "SYSTEMROOT",
          "WINDIR",
          "COMSPEC",
          "PATHEXT",
          "TMP",
          "TEMP",
        ])
          if (process.env[name] !== undefined) environment[name] = process.env[name];
        const result = spawnSync(
          process.execPath,
          [
            "--experimental-test-module-mocks",
            "--input-type=module",
            "--eval",
            String.raw`
          import assert from 'node:assert/strict';
          import {mock} from 'node:test';
          import {EventEmitter} from 'node:events';
          import {PassThrough} from 'node:stream';
          import path from 'node:path';
          import {createHash} from 'node:crypto';
          import * as children from 'node:child_process';
          import childProcess from 'node:child_process';
          import * as fileSystem from 'node:fs/promises';
          import {syncBuiltinESMExports} from 'node:module';
          ${fixtureModulePolicySource()}
          const entry=${JSON.stringify(entry.href)},phase=${JSON.stringify(phase)},variant=${JSON.stringify(variant)};
          const failure=[undefined,null,false,0,'',new Error('primary')][${index}];
          const secondary=new Error('secondary cleanup failure');
          const forbidden=()=>{throw new Error('Uncontrolled compatibility fixture IO is forbidden');};
          process.kill=forbidden;
          globalThis.WebSocket=class {constructor(){forbidden();}};
          const application=path.resolve('owned-app'),evidenceDirectory=path.resolve('owned-evidence');
          process.env.PORTCOVE_NATIVE_COMPATIBILITY_APP=application;
          process.env.PORTCOVE_NATIVE_COMPATIBILITY_EVIDENCE=evidenceDirectory;
          process.env.PORTCOVE_NATIVE_COMPATIBILITY_REVISION='inert-revision';
          const applicationBytes=Buffer.from('owned application fixture');
          const artifactIdentity={file:path.basename(application),size:applicationBytes.length,
            sha256:createHash('sha256').update(applicationBytes).digest('hex')};
          const writes=new Map(),logs=[];
          let quits=0,kills=0,spawns=0,checks=0,readiness=0,exits=0;
          const browser={takeScreenshot:async()=>'aW5lcnQ=',quit:async()=>{
            quits++;throw phase==='cleanup'?failure:secondary;}};
          class Builder {
            usingServer(url){assert.equal(url,'http://127.0.0.1:4445');return this;}
            withCapabilities(value){assert.deepEqual(value,{browserName:'tauri'});return this;}
            async build(){return browser;}
          }
          globalThis.compatibilityFixtureBuilder=Builder;
          registerHooks({resolve(specifier,context,next){
            if(specifier==='selenium-webdriver')return {url:'data:text/javascript,'+encodeURIComponent(
              'export const Builder=globalThis.compatibilityFixtureBuilder;export const By={};export const Key={ARROW_DOWN:"ArrowDown"};export const until={};'),shortCircuit:true};
            return next(specifier,context);
          },load(url,context,next){
            if(url!==entry)return next(url,context);
            if(variant==='removed-entrypoint')return {format:'module',source:'export {};',shortCircuit:true};
            const actual=next(url,context);
            return variant==='format'?{...actual,source:String(actual.source)+'\n// Harmless layout control.\n'}:actual;
          }});
          const controlledSpawn=(file,args,options)=>{
            spawns++;assert.equal(file,application);assert.deepEqual(args,[]);
            assert.equal(options.env.TAURI_WEBDRIVER_PORT,'4445');
            assert.deepEqual(options.stdio,['ignore','pipe','pipe']);assert.equal(options.windowsHide,true);
            const child=new EventEmitter();child.exitCode=null;child.signalCode=null;
            child.stdout=new PassThrough();child.stderr=new PassThrough();
            child.kill=signal=>{kills++;assert.equal(signal,undefined);child.exitCode=0;
              exits++;child.emit('exit',0,null);return true;};
            queueMicrotask(()=>{child.stdout.write('owned stdout');child.stderr.write('owned stderr');});
            return child;
          };
          for(const [name,value]of Object.entries(childProcess))if(typeof value==='function')Reflect.set(childProcess,name,forbidden);
          syncBuiltinESMExports();
          mock.module('node:child_process',{namedExports:{...Object.fromEntries(Object.entries(children)
            .filter(([name])=>name!=='default').map(([name,value])=>[name,typeof value==='function'?forbidden:value])),spawn:controlledSpawn}});
          mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(Object.entries(fileSystem)
            .filter(([name])=>name!=='default').map(([name,value])=>[name,typeof value==='function'?forbidden:value])),
            mkdir:async(file,options)=>{assert.equal(file,evidenceDirectory);assert.deepEqual(options,{recursive:true});},
            readFile:async(file)=>{assert.equal(file,application);return applicationBytes;},
            stat:async(file)=>{assert.equal(file,application);return {size:applicationBytes.length};},
            writeFile:async(file,value,options)=>{
              assert.equal(path.dirname(file),evidenceDirectory);
              assert.ok(['application.log','result.json','design-compatibility-environment.json','design-compatibility.png'].includes(path.basename(file)));
              if(file.endsWith('.json'))assert.deepEqual(options,{flag:'wx'});
              if(file.endsWith('.png'))assert.equal(options,'base64');
              writes.set(file,value);
            }}});
          mock.module(new URL('../scripts/desktop-design-compatibility-assertions.mts',entry).href,{namedExports:{
            assertDesignCompatibility:async(value)=>{checks++;assert.equal(value.browser,browser);
              assert.equal(value.selectActivationKey,'ArrowDown');
              if(phase==='primary')throw failure;return {observed:true};}}});
          globalThis.fetch=async(url,options)=>{readiness++;assert.equal(url,'http://127.0.0.1:4445/status');
            assert.ok(options.signal instanceof AbortSignal);return {ok:true};};
          console.log=value=>logs.push(value);
          await assert.rejects(import(entry),error=>Object.is(error,failure),
            'COMPATIBILITY_PRIMARY_IDENTITY must preserve the actual whole-script rejection');
          assert.equal(spawns,1);assert.equal(readiness,1);assert.equal(checks,1);
          assert.equal(quits,1);assert.equal(kills,1);assert.equal(exits,1);
          assert.equal(writes.get(path.join(evidenceDirectory,'application.log')),'owned stdoutowned stderr');
          const json=writes.get(path.join(evidenceDirectory,'result.json'));assert.ok(json);
          const evidence=JSON.parse(json);assert.equal(evidence.status,'failed');
          assert.deepEqual(evidence.artifact,artifactIdentity);assert.equal(evidence.revision,'inert-revision');
          assert.deepEqual(evidence.applicationExit,{code:0,signal:null});
          assert.equal(Object.hasOwn(evidence,'error'),phase==='primary');
          assert.equal(evidence.cleanupError,phase==='primary'?secondary.message:String(failure instanceof Error?failure.message:failure));
          const prefix='Native compatibility result: ';
          const records=logs.filter(value=>value.startsWith(prefix));assert.equal(records.length,1);
          assert.deepEqual(JSON.parse(records[0].slice(prefix.length)),{
            artifact:evidence.artifact,revision:evidence.revision,status:evidence.status,
            applicationExit:evidence.applicationExit,hasError:Object.hasOwn(evidence,'error'),
            hasCleanupError:Object.hasOwn(evidence,'cleanupError')});
          assert.equal(writes.has(path.join(evidenceDirectory,'design-compatibility-environment.json')),phase==='cleanup');
          assert.equal(writes.has(path.join(evidenceDirectory,'design-compatibility.png')),phase==='cleanup');
        `,
          ],
          {
            env: environment,
            encoding: "utf8",
            timeout: 10000,
            maxBuffer: 512 * 1024,
            windowsHide: true,
          },
        );
        assert.ifError(result.error);
        if (variant === "removed-entrypoint") {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /COMPATIBILITY_PRIMARY_IDENTITY/u);
        } else assert.equal(result.status, 0, result.stderr);
      }
    }
  }
});
