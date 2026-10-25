/** Read-only executable custody. This is filesystem evidence, never an
 * artifact, parent, execution or acceptance authority. */
import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isRecord } from "./runtime-values.mts";

export type NativeRuntimeCustody = ReadonlyMap<string, string>;

// Fixed OS reader, not a caller-supplied script or candidate process. All path
// input is inert UTF-8 JSON on stdin. This command never changes an ACL or owner.
const windowsCustodyReader = String.raw`
$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('portcove-native-custody: started')
if($PSVersionTable.PSVersion.Major -ne 7){throw 'Fixed native PowerShell7 runtime required'}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
$inputPaths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
if($inputPaths -isnot [Array] -or $inputPaths.Count -lt 1 -or $inputPaths.Count -gt 4096){throw 'Windows custody path inventory exceeds bound'}
[Console]::Error.WriteLine('portcove-native-custody: input-read')
$broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($broker,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$rows=@(foreach($entry in $inputPaths){
 if((($entry.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'file,path'){throw 'Windows custody path schema differs'}
 if($entry.path -isnot [string] -or $entry.file -isnot [bool]){throw 'Windows custody input differs'}
 $item=Get-Item -LiteralPath $entry.path -Force
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -eq $entry.file){throw 'Windows custody requires regular paths without reparse points'}
 $acl=Get-Acl -LiteralPath $entry.path
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if($owner -notin $trusted){throw 'Windows custody owner is outside the fixed broker/system boundary'}
 $replace=[Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
 if($entry.file){$replace=$replace -bor [Security.AccessControl.FileSystemRights]'Write'}
 foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
  if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
     $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $replace) -ne 0 -and
     $rule.IdentityReference.Value -notin $trusted){throw 'Windows custody permits a foreign writer or replacement'}
 }
 [ordered]@{path=$entry.path;owner=$owner;sddl=$acl.Sddl}
})
[Console]::Error.WriteLine('portcove-native-custody: custody-read')
ConvertTo-Json -InputObject ([ordered]@{schema_version=1;broker_sid=$broker;rows=$rows}) -Depth 4 -Compress
`;

function inspectWindowsCustody(files: readonly string[]): NativeRuntimeCustody {
  assert.ok(files.length > 0 && files.length <= 128, "bounded Windows custody inputs required");
  const inventory = new Map<string, { file: boolean; identity: string }>();
  const identity = (filename: string, regular: boolean) => {
    const info = lstatSync(filename, { bigint: true });
    assert.ok(!info.isSymbolicLink(), "linked Windows runtime refused");
    assert.ok(
      regular ? info.isFile() && info.nlink === 1n : info.isDirectory(),
      "Windows runtime requires regular single-link files and directory ancestry",
    );
    const values = [info.dev, info.ino, info.mode, info.birthtimeNs];
    if (regular) values.push(info.nlink, info.size, info.mtimeNs, info.ctimeNs);
    return values.join(":");
  };
  for (const filename of files) {
    assert.ok(
      /^[A-Za-z]:\\/u.test(filename) &&
        filename.length <= 4096 &&
        !filename.slice(2).includes(":") &&
        path.normalize(filename) === filename,
      "canonical local Windows runtime path required",
    );
    assert.equal(realpathSync(filename), filename, "linked Windows runtime refused");
    let depth = 0;
    for (let cursor = filename; ; cursor = path.dirname(cursor)) {
      assert.ok(++depth <= 64 && inventory.size < 4096, "Windows custody ancestry exceeds bound");
      const file = cursor === filename;
      const observed = { file, identity: identity(cursor, file) };
      const previous = inventory.get(cursor);
      assert.ok(
        !previous || (previous.file === file && previous.identity === observed.identity),
        "Windows custody changed during inventory",
      );
      inventory.set(cursor, observed);
      if (path.dirname(cursor) === cursor) break;
    }
    assert.equal(realpathSync(filename), filename);
  }
  const systemRoot = process.env.SystemRoot;
  assert.ok(
    systemRoot && systemRoot.toLowerCase() === "c:\\windows",
    "fixed Windows system root required",
  );
  const reader = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  assert.equal(realpathSync(reader), reader, "fixed Windows OS reader is linked");
  const input = JSON.stringify(
    [...inventory].map(([filename, item]) => ({ path: filename, file: item.file })),
  );
  assert.ok(Buffer.byteLength(input) <= 256 * 1024, "Windows custody request exceeds bound");
  let bytes: string;
  try {
    bytes = execFileSync(
      reader,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-InputFormat",
        "Text",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(windowsCustodyReader, "utf16le").toString("base64"),
      ],
      {
        input,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          PATH: path.join(systemRoot, "System32"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "child-refusal";
    throw new Error(`Windows custody OS read refused (${code}): ${stderr.slice(0, 4096)}`, {
      cause: error,
    });
  }
  const result: unknown = JSON.parse(bytes.replace(/^\uFEFF/u, ""));
  assert.ok(
    isRecord(result) &&
      Object.keys(result).sort().join(",") === "broker_sid,rows,schema_version" &&
      result.schema_version === 1 &&
      typeof result.broker_sid === "string" &&
      /^S-1-5-[0-9-]{1,180}$/u.test(result.broker_sid) &&
      Array.isArray(result.rows) &&
      result.rows.length === inventory.size,
    "Windows custody observation differs",
  );
  const observed = new Map<string, string>();
  for (const [index, [filename, item]] of [...inventory].entries()) {
    const row: unknown = result.rows[index];
    assert.ok(
      isRecord(row) &&
        Object.keys(row).sort().join(",") === "owner,path,sddl" &&
        row.path === filename &&
        typeof row.owner === "string" &&
        typeof row.sddl === "string" &&
        row.sddl.length > 0 &&
        row.sddl.length <= 16384,
      "Windows custody row differs",
    );
    assert.equal(
      identity(filename, item.file),
      item.identity,
      "Windows custody changed during ACL read",
    );
    assert.equal(realpathSync(filename), filename);
    observed.set(filename, JSON.stringify([item.identity, result.broker_sid, row.owner, row.sddl]));
  }
  return observed;
}

/** Linux retains broker/root ownership and mode checks. Windows retains the
 * fixed broker/system ACL boundary. Both reject aliases/replacement and retain
 * directory identity without mutable child-list timestamps. Neither observation
 * establishes a separate candidate account or an authenticated tool artifact. */
export function inspectNativeRuntimeCustody(files: readonly string[]): NativeRuntimeCustody {
  if (process.platform === "win32") return inspectWindowsCustody(files);
  const uid = process.getuid?.();
  assert.ok(process.platform === "linux" && uid !== undefined && uid !== 0);
  const observed = new Map<string, string>();
  for (const filename of files) {
    assert.ok(path.isAbsolute(filename) && path.normalize(filename) === filename);
    assert.equal(realpathSync(filename), filename, "linked native runtime refused");
    for (let cursor = filename; ; cursor = path.dirname(cursor)) {
      const info = lstatSync(cursor, { bigint: true });
      assert.ok(
        !info.isSymbolicLink() &&
          [0n, BigInt(uid)].includes(info.uid) &&
          (info.mode & 0o022n) === 0n,
        "native runtime custody is foreign-owned or writable",
      );
      const regular = cursor === filename;
      assert.ok(
        regular ? info.isFile() && info.nlink === 1n : info.isDirectory(),
        "native runtime requires regular single-link files and directory ancestry",
      );
      const identity = [info.dev, info.ino, info.uid, info.gid, info.mode];
      if (regular) identity.push(info.nlink, info.size, info.mtimeNs, info.ctimeNs);
      const serialized = identity.join(":");
      const previous = observed.get(cursor);
      assert.ok(previous === undefined || previous === serialized, "native custody changed");
      observed.set(cursor, serialized);
      if (cursor === "/") break;
    }
    assert.equal(realpathSync(filename), filename);
  }
  return observed;
}

export function recheckNativeRuntimeCustody(
  files: readonly string[],
  retained: NativeRuntimeCustody,
) {
  assert.deepEqual(inspectNativeRuntimeCustody(files), retained, "original native custody changed");
}
