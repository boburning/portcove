import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Refuse real package dependencies even when owned scratch inherits node_modules. */
export function fixtureModulePolicySource(ownedRoot?: string) {
  const root = ownedRoot ? pathToFileURL(path.resolve(ownedRoot) + path.sep).href : null;
  return `
    import { registerHooks, isBuiltin } from "node:module";
    const fixtureOwnedRoot = ${JSON.stringify(root)};
    registerHooks({ resolve(specifier, context, next) {
      if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("file:") && !specifier.startsWith("data:"))
        throw new Error("Unexpected package import: " + specifier);
      const resolved = next(specifier, context);
      if (fixtureOwnedRoot && resolved.url.startsWith("file:") && !resolved.url.startsWith(fixtureOwnedRoot))
        throw new Error("Fixture import escapes owned closure: " + specifier);
      return resolved;
    }});
  `;
}

/** Import full production modules before Desktop packages are installed.
 * Only inert package shapes cross this controlled dependency boundary. Browser
 * callbacks still execute through each test's real serialization fixture.
 */
export function runDesktopModuleFixture(
  entry: URL,
  program: string,
  control?: { exportName: string; variant: "aliased" | "wrong-export" },
  reply?:
    | { command: string; value: Record<string, unknown> }
    | { command: string; value: Record<string, unknown> }[],
) {
  const replies = reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
  for (const entry of replies) {
    assert.ok(typeof entry.command === "string" && entry.command.length > 0);
    assert.ok(
      entry.value !== null && typeof entry.value === "object" && !Array.isArray(entry.value),
    );
  }
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      `
        import assert from 'node:assert/strict';
        import {mock} from 'node:test';
        ${fixtureModulePolicySource()}
        import * as childProcess from 'node:child_process';
        const entry=${JSON.stringify(entry.href)};
        const control=${JSON.stringify(control ?? null)};
        const inertTransportReply=${JSON.stringify(reply ?? null)};
        const forbidden=()=>{throw Error('Native process execution is forbidden in this fixture');};
        process.kill=forbidden;
        globalThis.fetch=()=>{throw Error('Uncontrolled fixture network work is forbidden');};
        mock.module('node:child_process',{namedExports:Object.fromEntries(
          Object.entries(childProcess).filter(([name])=>name!=='default').map(([name,value])=>
            [name,typeof value==='function'?forbidden:value])
        )});
        // Actual IPC and schema admission remain forbidden. Only declared inert
        // command/object-identity pairs may cross the selected fixture boundary.
        const permittedReplies=Array.isArray(inertTransportReply)?inertTransportReply:inertTransportReply?[inertTransportReply]:[];
        mock.module(new URL('./transport-values.mts',entry).href,{namedExports:{
          transportValue:(command,value)=>{
            if(!permittedReplies.some(reply=>command===reply.command&&value===reply.value))return forbidden();
            return value;
          },transportValues:forbidden,
        }});
        registerHooks({resolve(specifier,context,next){
          if(specifier==='selenium-webdriver')return {url:'data:text/javascript,'+encodeURIComponent(
            'export class WebDriver{};export const By={css:value=>({using:"css selector",value}),xpath:value=>({using:"xpath",value}),id:value=>({using:"id",value})};export const Key={COMMAND:"fixture-command",CONTROL:"fixture-control",BACK_SPACE:"fixture-backspace",chord:(...keys)=>keys.join("+")};export const until={elementLocated:value=>value,elementIsVisible:element=>({fn:()=>element.isDisplayed()}),elementIsEnabled:element=>({fn:()=>element.isEnabled()})};'
          ),shortCircuit:true};
          if(specifier==='axe-core')return {url:'data:text/javascript,export default {}',shortCircuit:true};
          return next(specifier,context);
        },load(url,context,next){
          const loaded=next(url,context);if(url!==entry||!control)return loaded;
          if(control.variant==='wrong-export')
            return {...loaded,source:'export async function '+control.exportName+'(){}'};
          // Native ESM aliases also support implementation-local export aliases.
          const actual=new URL(entry);actual.searchParams.set('portcove-module-fixture','actual');
          const from=JSON.stringify(actual.href),name=JSON.stringify(control.exportName);
          return {...loaded,source:'import {'+name+' as $actualScenario} from '+from+';\\n'+
            'export * from '+from+';\\nexport {$actualScenario as '+name+'};\\n'};
        }});
        ${program}
      `,
    ],
    { env: environment, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
