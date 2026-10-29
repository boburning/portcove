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
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import { isRecord } from "./runtime-values.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";

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

void test("ordinary bootstrap reuses bounded Microsoft archive acquisition for x64 and arm64", async (context) => {
  const { downloadWindowsWebviewDriverArchive, prepareBootstrapWindowsWebviewDriver } =
    await import("./release-windows-webview-driver.mts");
  const { mkdir, readFile, readdir } = await import("node:fs/promises");
  const archive = createAuditZip(entries);
  const original = globalThis.fetch;
  const requests: string[] = [];
  let fault = "";
  globalThis.fetch = async (input, options) => {
    assert.ok(typeof input === "string");
    requests.push(input);
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("accept-encoding"), "identity");
    assert.ok(options?.signal);
    if (fault === "redirect") throw new Error("redirect refused");
    const body =
      fault === "oversize"
        ? Buffer.alloc(32 * 1024 ** 2 + 1)
        : fault === "traversal"
          ? createAuditZip([["../outside", "bad"]])
          : archive;
    return new Response(body, {
      status: 200,
      headers: fault === "encoding" ? { "content-encoding": "gzip" } : {},
    });
  };
  const root = await (
    await import("node:fs/promises")
  ).realpath(disposableDirectory(context, path.join(tmpdir(), "bounded-driver-bootstrap-")));
  try {
    for (const architecture of ["x64", "arm64"] as const) {
      const parent = path.join(root, architecture);
      await mkdir(parent);
      const destination = path.join(parent, "extract");
      const result = await prepareBootstrapWindowsWebviewDriver(
        "1.2.3.4",
        architecture,
        destination,
      );
      assert.equal(result.authority, "none");
      assert.equal(result.architecture, architecture);
      assert.equal(
        requests.at(-1),
        `https://msedgedriver.microsoft.com/1.2.3.4/edgedriver_${architecture === "x64" ? "win64" : "arm64"}.zip`,
      );
      assert.equal(
        (await readFile(path.join(destination, "bin/msedgedriver.exe"))).toString(),
        entries[0][1],
      );
      const calls = requests.length;
      await assert.rejects(
        prepareBootstrapWindowsWebviewDriver("1.2.3.4", architecture, destination),
      );
      assert.equal(requests.length, calls, "existing output must refuse before network");
      assert.equal(result.files.length, 4);
    }
    for (const mode of ["redirect", "encoding", "oversize", "traversal"]) {
      fault = mode;
      const parent = path.join(root, mode);
      await mkdir(parent);
      await assert.rejects(
        prepareBootstrapWindowsWebviewDriver("1.2.3.4", "x64", path.join(parent, "extract")),
      );
      assert.deepEqual(
        await readdir(parent),
        [],
        "invalid archive must not create extraction output",
      );
    }
    const calls = requests.length;
    await assert.rejects(downloadWindowsWebviewDriverArchive("../changed", "x64"));
    await assert.rejects(downloadWindowsWebviewDriverArchive("1.2.3.4", "other" as "x64"));
    assert.equal(requests.length, calls);
  } finally {
    globalThis.fetch = original;
  }
});

void test(
  "ordinary PowerShell bootstrap enters the actual bounded driver CLI without network or executable probes",
  { timeout: 45000 },
  async (context) => {
    const { mkdir, writeFile, readFile, realpath, access } = await import("node:fs/promises");
    const root = await realpath(
      disposableDirectory(context, path.join(tmpdir(), "pc-driver-cli-")),
    );
    const source = path.join(root, "source with spaces"),
      scripts = path.join(source, "scripts");
    await mkdir(scripts, { recursive: true });
    const closure = readFixtureModuleClosure(
      fileURLToPath(new URL("..", import.meta.url)),
      ["scripts/release-windows-webview-driver.mts"],
      { includeDynamicImports: false },
    );
    assert.ok(closure.external.every(isBuiltin));
    for (const module of closure.modules) {
      await mkdir(path.dirname(path.join(source, module.path)), { recursive: true });
      await writeFile(path.join(source, module.path), module.bytes, { flag: "wx" });
    }
    await writeFile(
      path.join(scripts, "bootstrap-quality-tools.ps1"),
      await readFile(new URL("./bootstrap-quality-tools.ps1", import.meta.url)),
      { flag: "wx" },
    );
    const archive = path.join(root, "archive.zip"),
      preload = path.join(root, "closed-fetch.mjs");
    await writeFile(archive, createAuditZip(entries), { flag: "wx" });
    await writeFile(
      preload,
      `import assert from 'node:assert/strict'; import{readFileSync,appendFileSync}from'node:fs';
globalThis.fetch=async(url,options)=>{assert.match(String(url),/^https:\\/\\/msedgedriver[.]microsoft[.]com\\/1[.]2[.]3[.]4\\/edgedriver_(win64|arm64)[.]zip$/);assert.equal(options.redirect,'error');assert.equal(options.headers['accept-encoding'],'identity');appendFileSync(process.env.OWNED_FETCHES,String(url)+'\\n');return new Response(readFileSync(process.env.OWNED_ARCHIVE));};`,
      { flag: "wx" },
    );
    const wrapper = path.join(scripts, "invoke-owned.ps1");
    await writeFile(
      wrapper,
      String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'bootstrap-quality-tools.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Fixture source parse failed'}
$definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Install-BoundedEdgeDriverFiles'},$true))
if($definitions.Count -ne 1){throw 'Actual bootstrap bridge required'}
$bridge=Join-Path $PSScriptRoot 'actual-bridge-functions.ps1'
[IO.File]::WriteAllText($bridge,$definitions[0].Extent.Text)
. $bridge
foreach($architecture in @('x64','arm64')){
 $parent=Join-Path $env:OWNED_ROOT $architecture;[IO.Directory]::CreateDirectory($parent)|Out-Null
 Install-BoundedEdgeDriverFiles '1.2.3.4' $architecture (Join-Path $parent 'extract')
}
$parent=Join-Path $env:OWNED_ROOT 'refused';[IO.Directory]::CreateDirectory($parent)|Out-Null
$refused=$false;try{Install-BoundedEdgeDriverFiles '../bad' 'x64' (Join-Path $parent 'extract')}catch{if($_.Exception.Message -cne 'Bounded Microsoft driver acquisition refused'){throw};$refused=$true}
if(-not $refused -or (Test-Path -LiteralPath (Join-Path $parent 'extract'))){throw 'Actual CLI wrong-input refusal lost'}
'actual-bootstrap-cli-passed'
`,
      { flag: "wx" },
    );
    const fetches = path.join(root, "fetches.txt");
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", wrapper], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 65536,
      env: {
        ...process.env,
        PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        OWNED_ROOT: root,
        OWNED_ARCHIVE: archive,
        OWNED_FETCHES: fetches,
      },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /actual-bootstrap-cli-passed/u);
    assert.equal((await readFile(fetches, "utf8")).trim().split("\n").length, 2);
    for (const arch of ["x64", "arm64"]) {
      const folder = path.join(root, arch, "extract");
      assert.equal(
        (await readFile(path.join(folder, "bin/msedgedriver.exe"))).toString(),
        entries[0][1],
      );
      const report: unknown = JSON.parse(
        await readFile(path.join(folder, "bootstrap-driver-acquisition.json"), "utf8"),
      );
      assert.ok(isRecord(report));
      assert.equal(report.architecture, arch);
      assert.equal(report.authority, "none");
    }
    await assert.rejects(access(path.join(root, "refused", "extract")));
  },
);
