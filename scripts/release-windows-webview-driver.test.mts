import assert from "node:assert/strict";
import test from "node:test";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import {
  inspectWindowsWebviewDriverArchive,
  acquireWindowsWebviewDriver,
} from "./release-windows-webview-driver.mts";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import path from "node:path";
import { tmpdir } from "node:os";

const entries = [
  ["msedgedriver.exe", "inert Microsoft-shaped binary"],
  ["Driver_Notes/LICENSE", "license"],
  ["Driver_Notes/EULA", "eula"],
  ["Driver_Notes/credits.html", "<html>credits</html>"],
] as const;

void test("Microsoft driver ZIP preflight preserves the complete bounded binary/license inventory before writes", () => {
  for (const method of [0, 8]) {
    const bytes = createAuditZip(
        entries.map(([name, value]) => [name, value, { method, descriptor: true }]),
      ),
      result = inspectWindowsWebviewDriverArchive(bytes);
    assert.equal(result.files.size, 4);
    assert.equal(result.files.get("bin/msedgedriver.exe")?.toString(), entries[0][1]);
    assert.equal(result.files.get("webview-driver-eula.txt")?.toString(), "eula");
    assert.equal(result.archive_bytes, bytes.length);
    assert.equal(result.authority, "none");
  }
});

void test("Microsoft driver ZIP refuses missing, extra, linked, duplicate and corrupt members", () => {
  for (const bytes of [
    createAuditZip(entries.slice(1)),
    createAuditZip([...entries, ["outside/extra", "unexpected"]]),
    createAuditZip(
      entries.map(([name, value], index) => [
        name,
        value,
        { attributes: index === 0 ? 0xa1a40000 : 0x81a40000 },
      ]),
    ),
    createAuditZip([entries[0], entries[0], entries[2], entries[3]]),
  ])
    assert.throws(() => inspectWindowsWebviewDriverArchive(bytes));
  const corrupt = createAuditZip(entries.map(([name, value]) => [name, value, { method: 0 }]));
  corrupt[30 + Buffer.byteLength(entries[0][0])]! ^= 1;
  assert.throws(() => inspectWindowsWebviewDriverArchive(corrupt), /CRC/);
});

void test("only the exact inert Microsoft directory record is opted in; ordinary ZIP consumers remain strict", () => {
  const directory = ["Driver_Notes/", "", { method: 0, attributes: 0x10 }] as const,
    zip = createAuditZip([directory, ...entries]);
  assert.equal(inspectWindowsWebviewDriverArchive(zip).files.size, 4);
  assert.throws(
    () =>
      inspectBoundedZip(zip, {
        compressedBytes: 1024 * 1024,
        expandedBytes: 1024 * 1024,
        files: 5,
        nameBytes: 64,
        allowedPaths: new Set(["Driver_Notes/", ...entries.map(([name]) => name)]),
      }),
    /nonregular/,
  );
  for (const entry of [
    ["Driver_Notes/", "not empty", { method: 0, attributes: 0x10 }],
    ["Driver_Notes/", "", { method: 8, attributes: 0x10 }],
    ["Driver_Notes/", "", { method: 0, attributes: 0xa1a40010 }],
    ["other/", "", { method: 0, attributes: 0x10 }],
  ] as const)
    assert.throws(() => inspectWindowsWebviewDriverArchive(createAuditZip([entry, ...entries])));
});

void test("Microsoft driver raw size declarations refuse before inflation or extraction allocation", () => {
  const bytes = createAuditZip(entries),
    end = bytes.length - 22,
    central = bytes.readUInt32LE(end + 16);
  bytes.writeUInt32LE(64 * 1024 ** 2 + 1, 22);
  bytes.writeUInt32LE(64 * 1024 ** 2 + 1, central + 24);
  assert.throws(() => inspectWindowsWebviewDriverArchive(bytes), /member exceeds bound/);
  const metadata = createAuditZip(entries);
  metadata.writeUInt16LE(65535, central + 28);
  assert.throws(() => inspectWindowsWebviewDriverArchive(metadata), /metadata limit/);
});

void test("Microsoft driver acquisition refuses unsupported host before source or output access", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "unsupported", configurable: true });
  try {
    await assert.rejects(acquireWindowsWebviewDriver("missing-source", "missing-tools", {}));
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

void test("closed driver source acquisition binds fresh files and keeps failures without changing shared state", (context) => {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-edge-source-")),
    module = new URL("./release-windows-webview-driver.mts", import.meta.url).href,
    zip = createAuditZip([["Driver_Notes/", "", { method: 0, attributes: 0x10 }], ...entries]);
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';import path from 'node:path';
Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});
const root=process.argv[1],archive=Buffer.from(${JSON.stringify(zip.toString("base64"))},'base64');
const source=path.join(root,'source');await mkdir(path.join(source,'scripts'),{recursive:true});
await writeFile(path.join(source,'scripts/windows-webview-driver-policy.psm1'),'inert controlled policy');
let fault='',calls=0,fetches=0;
globalThis.edgePeer=(exe,args,options)=>{
 assert.equal(exe,'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
 assert.equal(options.env.PATHEXT,'.EXE');assert.equal(options.timeout,15000);assert.equal(options.stdio,'pipe');
 calls++;if(calls===1)return JSON.stringify({version:fault==='version'?'1.2/escape':'1.2.3.4'});
 if(fault==='signature')throw Object.assign(new Error('inert observer refusal'),{status:1,stderr:'inert signature failure',stdout:''});
 return JSON.stringify({version:'1.2.3.4',subject:'CN=Microsoft Corporation',thumbprint:'A'.repeat(40)});
};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(module)}&&s==='node:child_process')return {url:'edge-peer:child',shortCircuit:true};return next(s,c)},load(u,c,next){if(u==='edge-peer:child')return {format:'module',source:'export const execFileSync=globalThis.edgePeer;',shortCircuit:true};return next(u,c)}});
globalThis.fetch=async(url,options)=>{fetches++;assert.equal(url,'https://msedgedriver.microsoft.com/1.2.3.4/edgedriver_win64.zip');assert.equal(options.redirect,'error');assert.equal(options.headers['accept-encoding'],'identity');return {status:200,headers:{get:()=>null},body:(async function*(){yield archive})()}};
const api=await import(${JSON.stringify(module)});
for(const scenario of ['valid','signature','version']){
 fault=scenario;calls=fetches=0;const parent=path.join(root,scenario);await mkdir(parent);const tools=path.join(parent,'tools');
 if(scenario==='valid'){
  const result=await api.acquireWindowsWebviewDriver(source,tools,{PATHEXT:'.BAD'});assert.equal(result.version,'1.2.3.4');assert.equal(result.authority,'none');assert.equal(result.signature_status,'Valid');assert.deepEqual(result.empty_directories,['Driver_Notes/']);
  assert.equal((await readFile(path.join(tools,'bin/msedgedriver.exe'),'utf8')),${JSON.stringify(entries[0][1])});assert.equal(calls,2);assert.equal(fetches,1);
  const binary=await readFile(path.join(tools,'bin/msedgedriver.exe')),policy=await readFile(path.join(source,'scripts/windows-webview-driver-policy.psm1'));
  assert.equal(api.inspectWindowsWebviewDriverProof(result,binary,policy).version,'1.2.3.4');
  for(const field of ['url','scope','signature_status','executable','policy_sha256','extra']){
   const bad=structuredClone(result);if(field==='executable')bad.executable.sha256='0'.repeat(64);else if(field==='extra')bad.unselected=true;else bad[field]='changed';
   assert.throws(()=>api.inspectWindowsWebviewDriverProof(bad,binary,policy));
  }
  assert.throws(()=>api.inspectWindowsWebviewDriverProof(result,Buffer.from('changed'),policy));
  assert.throws(()=>api.inspectWindowsWebviewDriverProof(result,binary,Buffer.from('changed')));
 }else{
  const error=await api.acquireWindowsWebviewDriver(source,tools,{PATHEXT:'.BAD'}).then(()=>assert.fail('source refusal expected'),error=>error);
  assert.equal(fetches,scenario==='version'?0:1);await assert.rejects(access(path.join(tools,'webview-driver.json')));
  if(scenario==='signature'){assert.equal(error.diagnostic.status,1);assert.equal(error.diagnostic.stderr_prefix,'inert signature failure');assert.equal((await readFile(path.join(parent,'webview-driver-download.zip'))).length,archive.length);}
 }
}
console.log('closed driver source controls passed; no actual Microsoft/native observation');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /closed driver source controls passed/);
});
