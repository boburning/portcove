import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  linkSync,
  symlinkSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectNativeRuntimeCustody,
  projectWindowsCustodyFailure,
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
let links=2n,foreign=false,stderr='foreign writer';const reads=[];
globalThis.systemPeers={path:path.win32,realpath:value=>value,stat:value=>({isSymbolicLink:()=>false,isFile:()=>value.endsWith('.exe')||value.endsWith('.bin'),isDirectory:()=>!value.endsWith('.exe')&&!value.endsWith('.bin'),nlink:links,dev:1n,ino:BigInt(value.length),mode:448n,birthtimeNs:1n,size:16n,mtimeNs:2n,ctimeNs:3n}),exec:(reader,args,options)=>{assert.equal(reader,'C:\\Program Files\\PowerShell\\7\\pwsh.exe');if(foreign)throw Object.assign(Error('controlled foreign ACL'),{code:'EACCES',status:1,stderr});const input=JSON.parse(options.input);reads.push(input);return JSON.stringify({schema_version:1,broker_sid:'S-1-5-18',rows:input.map(v=>({path:v.path,owner:'S-1-5-18',sddl:'O:SYD:(A;;FA;;;SY)'}))})}};
const routes={'node:fs':'fs','node:path':'path','node:child_process':'exec'};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(entry)}&&routes[s])return {url:'system-peer:'+routes[s],shortCircuit:true};return next(s,c)},load(u,c,next){if(u.startsWith('system-peer:'))return {format:'module',source:u==='system-peer:fs'?'export const lstatSync=globalThis.systemPeers.stat;export const realpathSync=globalThis.systemPeers.realpath;':u==='system-peer:path'?'export default globalThis.systemPeers.path;':'export const execFileSync=globalThis.systemPeers.exec;',shortCircuit:true};return next(u,c)}});
const api=await import(${JSON.stringify(entry)}),paths=Object.values(api.windowsSourceSystemExecutables);
for(const filename of [...paths,'C:\\owned\\controller.bin'])assert.throws(()=>api.inspectNativeRuntimeCustody([filename]),/single-link/);
const original=api.inspectWindowsSourceSystemCustody();api.recheckWindowsSourceSystemCustody(original);
assert.deepEqual(reads[0].filter(row=>row.file).map(row=>row.path).sort(),paths.sort());
links=3n;assert.throws(()=>api.recheckWindowsSourceSystemCustody(original),/changed/);links=2n;
foreign=true;assert.throws(()=>api.inspectWindowsSourceSystemCustody(),error=>error.code==='ERR_WINDOWS_CUSTODY_REFUSED'&&api.projectWindowsCustodyFailure(error).spawn_code==='EACCES');
const closed={schema_version:1,reason:'writer',phase:'rules',ordinal:0,kind:'file',principal_class:'everyone',rights:16};
for(const [value,accepted]of [[JSON.stringify(closed),true],['{invalid',false],[JSON.stringify({...closed,raw_path:'private-marker'}),false],[JSON.stringify({...closed,reason:'unknown-private-marker'}),false],[JSON.stringify({...closed,rights:32}),false]]){
 stderr='portcove-native-custody-failure:'+value+'\n';
 assert.throws(()=>api.inspectWindowsSourceSystemCustody(),error=>{const detail=api.projectWindowsCustodyFailure(error);assert.equal(detail.reader!==null,accepted);assert.equal(error.message.includes('private-marker'),false);return error.code==='ERR_WINDOWS_CUSTODY_REFUSED';});
}
stderr='portcove-native-custody-failure:'+JSON.stringify(closed)+'\nportcove-native-custody-failure:'+JSON.stringify(closed)+'\n';
assert.throws(()=>api.inspectWindowsSourceSystemCustody(),error=>api.projectWindowsCustodyFailure(error).reader===null);

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
      assert.throws(
        () => inspectNativeRuntimeCustody([file]),
        (error) => projectWindowsCustodyFailure(error)?.reader?.reason === "writer",
      );
    } finally {
      acl(file, "restore", fileAcl);
    }
    const directoryAcl = acl(directory, "directory-replacer");
    try {
      assert.throws(
        () => recheckNativeRuntimeCustody([file], original),
        (error) => projectWindowsCustodyFailure(error)?.reader?.reason === "writer",
      );
    } finally {
      acl(directory, "restore", directoryAcl);
    }
    inspectNativeRuntimeCustody([file]);
  },
);

void test(
  "Windows custody classifies the real hosted runtime and source before candidate work",
  { ...windows, timeout: 120000 },
  (t) => {
    const { file } = fixture(t);
    const project = fileURLToPath(new URL("..", import.meta.url));
    const candidates: [string, string | null][] = [
      ["fixed-system", null],
      ["original-node", process.execPath],
      [
        "checked-out-policy",
        fileURLToPath(new URL("./windows-webview-driver-policy.psm1", import.meta.url)),
      ],
      [
        "checked-out-custody",
        fileURLToPath(new URL("./release-native-runtime-custody.mts", import.meta.url)),
      ],
      ["owned-home-control", file],
      ["cache-state-if-present", path.join(project, "work/tool-bin/tool-state.json")],
      [
        "built-verifier-if-present",
        path.join(project, "target/release/portcove-release-tools.exe"),
      ],
    ];
    const rows: {
      label: string;
      status: string;
      entries?: number;
      custody?: ReturnType<typeof projectWindowsCustodyFailure>;
    }[] = [];
    for (const [label, filename] of candidates) {
      if (filename && !existsSync(filename)) {
        rows.push({ label, status: "not-evaluated-absent" });
        continue;
      }
      try {
        const custody = filename
          ? inspectNativeRuntimeCustody([filename])
          : inspectWindowsSourceSystemCustody();
        rows.push({ label, status: "accepted", entries: custody.size });
      } catch (error) {
        rows.push({ label, status: "refused", custody: projectWindowsCustodyFailure(error) });
      }
    }
    const publicRecord = {
      schema_version: 1,
      scope: "read-only actual hosted path-role custody classification; no candidate or authority",
      rows,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(publicRecord)) <= 16384);
    t.diagnostic("Closed hosted custody inventory: " + JSON.stringify(publicRecord));
    assert.equal(rows.find((row) => row.label === "fixed-system")?.status, "accepted");
    assert.equal(rows.find((row) => row.label === "owned-home-control")?.status, "accepted");
    for (const row of rows.filter((row) => row.status === "refused")) {
      assert.ok(row.custody?.reader, "OS read/query Unknown is not a qualified policy refusal");
      assert.ok(["writer", "owner"].includes(row.custody.reader.reason));
      assert.equal(row.custody.child_status, 1);
    }
  },
);

void test(
  "fixed Windows custody reader preserves trusted principals and closed foreign-rights refusals",
  { ...windows, timeout: 120000 },
  () => {
    const implementation = readFileSync(
      new URL("./release-native-runtime-custody.mts", import.meta.url),
      "utf8",
    );
    const reader = /const windowsCustodyReader = String[.]raw`([\s\S]+?)`;/u.exec(
      implementation,
    )?.[1];
    assert.ok(reader, "Actual fixed reader body required");
    const scenarios = [
      "broker",
      "system",
      "administrators",
      "trusted-installer",
      "foreign-write",
      "foreign-delete-child",
      "inherit-only",
      "deny",
      "os-failure",
      "bad-input",
    ] as const;
    for (const scenario of scenarios) {
      const directory = scenario === "foreign-delete-child" || scenario === "inherit-only";
      const prefix =
        `$fixtureScenario='${scenario}';$fixtureDirectory=$${String(directory)};` +
        String.raw`
function Get-Item {param($LiteralPath,[switch]$Force) [pscustomobject]@{Attributes=[IO.FileAttributes]::Normal;PSIsContainer=$fixtureDirectory}}
function Get-Acl {param($LiteralPath)
 if($fixtureScenario -eq 'os-failure'){throw 'private-custody-control-marker'}
 $broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $acl=if($fixtureDirectory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
 $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($broker))
 $sid=switch($fixtureScenario){'system'{'S-1-5-18'};'administrators'{'S-1-5-32-544'};'trusted-installer'{'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'};'broker'{$broker};default{'S-1-1-0'}}
 $rights=if($fixtureScenario -in @('foreign-delete-child','inherit-only')){'DeleteSubdirectoriesAndFiles'}elseif($fixtureScenario -in @('foreign-write','inherit-only','deny')){'Write'}else{'FullControl'}
 $propagation=if($fixtureScenario -eq 'inherit-only'){'InheritOnly'}else{'None'}
 $inheritance=if($fixtureScenario -eq 'inherit-only'){'ObjectInherit'}else{'None'}
 $type=if($fixtureScenario -eq 'deny'){'Deny'}else{'Allow'}
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]$rights,[Security.AccessControl.InheritanceFlags]$inheritance,[Security.AccessControl.PropagationFlags]$propagation,[Security.AccessControl.AccessControlType]$type))
 return $acl
}
`;
      const result: SpawnSyncReturns<string> = spawnSync(
        windowsSourceSystemExecutables.powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-InputFormat",
          "Text",
          "-OutputFormat",
          "Text",
          "-EncodedCommand",
          Buffer.from(prefix + reader, "utf16le").toString("base64"),
        ],
        {
          input: JSON.stringify([
            scenario === "bad-input"
              ? { path: "C:\\inert-control", file: false, forbidden: true }
              : { path: "C:\\inert-control", file: !directory },
            { path: "C:\\inert-control-second", file: !directory },
          ]),
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 65536,
          windowsHide: true,
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.SystemRoot,
            PATH: path.win32.join(process.env.SystemRoot!, "System32"),
          },
        },
      );
      assert.equal(result.error, undefined, scenario);
      assert.equal(result.stderr.includes("private-custody-control-marker"), false);
      if (["foreign-write", "foreign-delete-child", "os-failure", "bad-input"].includes(scenario)) {
        assert.equal(result.status, 1, scenario);
        const prefix = "portcove-native-custody-failure:";
        const lines = result.stderr.trim().split(/\r?\n/u);
        assert.equal(lines.length, 1);
        assert.ok(lines[0]!.startsWith(prefix));
        const detail = JSON.parse(lines[0]!.slice(prefix.length)) as Record<string, unknown>;
        assert.equal(
          Object.keys(detail).sort().join(","),
          "kind,ordinal,phase,principal_class,reason,rights,schema_version",
        );
        assert.equal(
          detail.reason,
          scenario === "os-failure" ? "os-read" : scenario === "bad-input" ? "input" : "writer",
        );
        assert.equal(detail.ordinal, 0);
        if (scenario === "foreign-write") {
          assert.equal(detail.kind, "file");
          assert.ok((Number(detail.rights) & 16) !== 0);
        }
        if (scenario === "foreign-delete-child") {
          assert.equal(detail.kind, "directory");
          assert.ok((Number(detail.rights) & 2) !== 0);
        }
        assert.equal(result.stderr.includes("C:\\inert-control"), false);
      } else {
        assert.equal(result.status, 0, scenario);
        assert.equal(result.stderr, "");
        assert.equal((JSON.parse(result.stdout) as { schema_version: number }).schema_version, 1);
      }
    }
  },
);
