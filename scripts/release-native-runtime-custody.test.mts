import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  linkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
  windowsSourceSystemExecutables,
} from "./release-native-runtime-custody.mts";
import { lstatSync } from "node:fs";

const windows = { skip: process.platform !== "win32" };

void test(
  "fixed Windows source-system custody observes only its two host-image files",
  { ...windows, timeout: 60000 },
  () => {
    assert.equal(inspectWindowsSourceSystemCustody.length, 0);
    assert.ok(Object.isFrozen(windowsSourceSystemExecutables));
    const original = inspectWindowsSourceSystemCustody();
    assert.deepEqual(
      [...original.keys()].filter((name) => name.endsWith(".exe")).sort(),
      Object.values(windowsSourceSystemExecutables).sort(),
    );
    recheckWindowsSourceSystemCustody(original);
    for (const filename of Object.values(windowsSourceSystemExecutables))
      if (lstatSync(filename).nlink > 1)
        assert.throws(() => inspectNativeRuntimeCustody([filename]), /single-link/);
  },
);

void test("controlled system-image hardlinks never relax controller inputs or ACL/drift refusal", () => {
  const entry = new URL("./release-native-runtime-custody.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import path from 'node:path';
Object.defineProperties(process,{platform:{value:'win32'},arch:{value:'x64'}});process.env.SystemRoot='C:\\Windows';
let links=2n,foreign=false;const reads=[];
globalThis.systemPeers={path:path.win32,realpath:value=>value,stat:value=>({isSymbolicLink:()=>false,isFile:()=>value.endsWith('.exe')||value.endsWith('.bin'),isDirectory:()=>!value.endsWith('.exe')&&!value.endsWith('.bin'),nlink:links,dev:1n,ino:BigInt(value.length),mode:448n,birthtimeNs:1n,size:16n,mtimeNs:2n,ctimeNs:3n}),exec:(reader,args,options)=>{assert.equal(reader,'C:\\Program Files\\PowerShell\\7\\pwsh.exe');if(foreign)throw Object.assign(Error('controlled foreign ACL'),{code:'EACCES',stderr:'foreign writer'});const input=JSON.parse(options.input);reads.push(input);return JSON.stringify({schema_version:1,broker_sid:'S-1-5-18',rows:input.map(v=>({path:v.path,owner:'S-1-5-18',sddl:'O:SYD:(A;;FA;;;SY)'}))})}};
const routes={'node:fs':'fs','node:path':'path','node:child_process':'exec'};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'system-peer:'+routes[s],shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('system-peer:'))return {format:'module',source:u==='system-peer:fs'?'export const lstatSync=globalThis.systemPeers.stat;export const realpathSync=globalThis.systemPeers.realpath;':u==='system-peer:path'?'export default globalThis.systemPeers.path;':'export const execFileSync=globalThis.systemPeers.exec;',shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)}),paths=Object.values(api.windowsSourceSystemExecutables);
for(const filename of [...paths,'C:\\owned\\controller.bin'])assert.throws(()=>api.inspectNativeRuntimeCustody([filename]),/single-link/);
const original=api.inspectWindowsSourceSystemCustody();api.recheckWindowsSourceSystemCustody(original);
assert.deepEqual(reads[0].filter(row=>row.file).map(row=>row.path).sort(),paths.sort());
links=3n;assert.throws(()=>api.recheckWindowsSourceSystemCustody(original),/changed/);links=2n;
foreign=true;assert.throws(()=>api.inspectWindowsSourceSystemCustody(),/foreign writer/);
console.log('controlled fixed system-image custody passed; no actual Windows observations');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /controlled fixed system-image custody passed/u);
});
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.homedir(), ".portcove-custody-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "tools");
  mkdirSync(directory);
  const file = path.join(directory, "inert-π.txt");
  writeFileSync(file, "inert data; never execute");
  return { root, directory, file };
}

void test(
  "Windows custody retains real owner/ACL/identity and refuses same-byte replacement",
  windows,
  (t) => {
    const { file } = fixture(t);
    const original = inspectNativeRuntimeCustody([file]);
    assert.ok(original.size >= 5);
    recheckNativeRuntimeCustody([file], original);
    renameSync(file, file + ".retained");
    writeFileSync(file, "inert data; never execute");
    assert.throws(() => recheckNativeRuntimeCustody([file], original), /custody/);
  },
);

void test(
  "Windows custody refuses hard links, junction ancestry and noncanonical requests",
  windows,
  (t) => {
    const { root, directory, file } = fixture(t);
    const hard = path.join(directory, "alias");
    linkSync(file, hard);
    assert.throws(() => inspectNativeRuntimeCustody([file]), /single-link/);
    rmSync(hard);
    const junction = path.join(root, "junction");
    symlinkSync(directory, junction, "junction");
    assert.throws(
      () => inspectNativeRuntimeCustody([path.join(junction, "inert-π.txt")]),
      /linked/,
    );
    for (const invalid of [
      "relative",
      "\\\\server\\share\\file",
      file + ":stream",
      path.join(directory, ".") + "\\inert-π.txt\\..\\inert-π.txt",
    ])
      assert.throws(() => inspectNativeRuntimeCustody([invalid]));
    assert.throws(() => inspectNativeRuntimeCustody([]), /bounded/);
    assert.throws(() => inspectNativeRuntimeCustody(Array(129).fill(file)), /bounded/);
  },
);

function acl(
  filename: string,
  operation: "file-writer" | "directory-replacer" | "restore",
  sddl?: string,
) {
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$value=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$acl=Get-Acl -LiteralPath $value.filename
$original=$acl.Sddl
if($value.operation -ceq 'restore'){$acl.SetSecurityDescriptorSddlForm($value.sddl)}else{
 $rights=if($value.operation -ceq 'file-writer'){'Write'}else{'DeleteSubdirectoriesAndFiles'}
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.FileSystemRights]$rights,[Security.AccessControl.AccessControlType]::Allow))
}
Set-Acl -LiteralPath $value.filename -AclObject $acl
ConvertTo-Json -InputObject $original -Compress
`;
  const result = spawnSync(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ filename, operation, sddl }),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      windowsHide: true,
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\Windows\\System32" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, "")) as string;
}

void test(
  "Windows custody refuses foreign file writers and ancestor replacement in owned fixtures",
  windows,
  (t) => {
    const { directory, file } = fixture(t);
    const original = inspectNativeRuntimeCustody([file]);
    const fileAcl = acl(file, "file-writer");
    try {
      assert.throws(() => inspectNativeRuntimeCustody([file]), /foreign writer/);
    } finally {
      acl(file, "restore", fileAcl);
    }
    const directoryAcl = acl(directory, "directory-replacer");
    try {
      assert.throws(() => recheckNativeRuntimeCustody([file], original), /foreign writer/);
    } finally {
      acl(directory, "restore", directoryAcl);
    }
    inspectNativeRuntimeCustody([file]);
  },
);
