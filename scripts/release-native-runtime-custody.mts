/** Read-only executable custody. This is filesystem evidence, never an
 * artifact, parent, execution or acceptance authority. */
import assert from "node:assert/strict";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { isRecord } from "./runtime-values.mts";

export type NativeRuntimeCustody = ReadonlyMap<string, string>;
export const windowsSourceSystemExecutables = Object.freeze({
  git: "C:\\Program Files\\Git\\cmd\\git.exe",
  powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
});

/** Exact native FILETIME data only. Existing callers retain PID/generation,
 * lineage, admission and original deadline ownership; global lock/CIM formats stay unchanged. */
export function readWindowsNativeProcessFiletime(pid: number, deadline: number): string | null {
  assert.equal(process.platform, "win32");
  assert.ok(
    Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647,
    "Exact native PID required; zero/unknown is not absence",
  );
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(
    Number.isFinite(deadline) && remaining > 0,
    "Original native identity window exhausted",
  );
  const system = process.env.SystemRoot;
  assert.ok(system && /^[A-Za-z]:\\/u.test(system));
  const tracking = process.env.RUNNER_TRACKING_ID;
  assert.ok(
    tracking === undefined ||
      (tracking.length > 0 && tracking.length <= 32768 && !tracking.includes("\0")),
    "Original provider tracking differs",
  );
  const value = execFileSync(
    windowsSourceSystemExecutables.powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop';try{$p=[Diagnostics.Process]::GetProcessById(${pid})}catch [ArgumentException]{[Console]::Out.Write('absent');exit 0};try{if($p.Id -ne ${pid}){throw 'Original PID differs'};[Console]::Out.Write($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture))}finally{$p.Dispose()}`,
    ],
    {
      encoding: "utf8",
      timeout: Math.min(5000, remaining),
      maxBuffer: 1024,
      windowsHide: true,
      env: {
        SystemRoot: system,
        WINDIR: system,
        PATH: path.win32.join(system, "System32"),
        PATHEXT: ".EXE",
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...(tracking === undefined ? {} : { RUNNER_TRACKING_ID: tracking }),
      },
    },
  ).trim();
  assert.ok(performance.now() < deadline, "Native identity observation exceeded original window");
  if (value === "absent") return null;
  assert.match(
    value,
    /^[1-9][0-9]{0,18}$/u,
    "Exact native FILETIME required; malformed/query failures are not absence",
  );
  return value;
}

const custodyReasons = ["runtime", "input", "regular-path", "owner", "writer", "os-read"];
const custodyPhases = ["entry", "input", "item", "acl", "owner", "rules", "complete"];
const custodyPrincipals = [
  "unknown",
  "everyone",
  "authenticated-users",
  "builtin-users",
  "interactive",
  "logon-session",
  "creator-owner",
  "other",
];
const custodySpawnCodes = ["unknown", "ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS"];
type WindowsCustodyReaderFailure = {
  schema_version: 1;
  reason: string;
  phase: string;
  ordinal: number | null;
  kind: string;
  principal_class: string;
  rights: number;
};
type WindowsCustodyFailure = {
  schema_version: 1;
  child_status: number | null;
  child_signal: string | null;
  spawn_code: string;
  reader: WindowsCustodyReaderFailure | null;
};
function closedCustodyReaderFailure(raw: unknown): WindowsCustodyReaderFailure | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "kind,ordinal,phase,principal_class,reason,rights,schema_version" ||
    raw.schema_version !== 1 ||
    !custodyReasons.includes(String(raw.reason)) ||
    !custodyPhases.includes(String(raw.phase)) ||
    !["unknown", "file", "directory"].includes(String(raw.kind)) ||
    !custodyPrincipals.includes(String(raw.principal_class)) ||
    !(
      raw.ordinal === null ||
      (Number.isSafeInteger(raw.ordinal) && Number(raw.ordinal) >= 0 && Number(raw.ordinal) < 4096)
    ) ||
    !Number.isSafeInteger(raw.rights) ||
    Number(raw.rights) < 0 ||
    Number(raw.rights) > 31
  )
    return null;
  return {
    schema_version: 1,
    reason: String(raw.reason),
    phase: String(raw.phase),
    ordinal: raw.ordinal as number | null,
    kind: String(raw.kind),
    principal_class: String(raw.principal_class),
    rights: Number(raw.rights),
  };
}
function readWindowsCustodyFailure(error: unknown): WindowsCustodyFailure {
  const result: WindowsCustodyFailure = {
    schema_version: 1,
    child_status: null,
    child_signal: null,
    spawn_code: "unknown",
    reader: null,
  };
  try {
    if (!isRecord(error)) return result;
    if (
      Number.isSafeInteger(error.status) &&
      Number(error.status) >= 0 &&
      Number(error.status) <= 0xffff_ffff
    )
      result.child_status = Number(error.status);
    if (["SIGTERM", "SIGKILL"].includes(String(error.signal)))
      result.child_signal = String(error.signal);
    if (typeof error.code === "string" && custodySpawnCodes.includes(error.code))
      result.spawn_code = error.code;
    if (typeof error.stderr === "string" && Buffer.byteLength(error.stderr) <= 16384) {
      const prefix = "portcove-native-custody-failure:",
        rows = error.stderr.split(/\r?\n/u).filter((row) => row.startsWith(prefix));
      if (rows.length === 1 && Buffer.byteLength(rows[0]!) <= 2048)
        result.reader = closedCustodyReaderFailure(JSON.parse(rows[0]!.slice(prefix.length)));
    }
  } catch {
    /* Unavailable diagnostics never replace the original custody refusal. */
  }
  return result;
}
/** Closed, unbranded diagnostic data only; never executable custody or authority. */
export function projectWindowsCustodyFailure(error: unknown): WindowsCustodyFailure | null {
  try {
    if (!(error instanceof Error)) return null;
    const raw: unknown = Object.getOwnPropertyDescriptor(error, "windows_custody")?.value;
    if (
      !isRecord(raw) ||
      Object.keys(raw).sort().join(",") !==
        "child_signal,child_status,reader,schema_version,spawn_code" ||
      raw.schema_version !== 1 ||
      !(
        raw.child_status === null ||
        (Number.isSafeInteger(raw.child_status) &&
          Number(raw.child_status) >= 0 &&
          Number(raw.child_status) <= 0xffff_ffff)
      ) ||
      !(
        raw.child_signal === null ||
        (typeof raw.child_signal === "string" && ["SIGTERM", "SIGKILL"].includes(raw.child_signal))
      ) ||
      typeof raw.spawn_code !== "string" ||
      !custodySpawnCodes.includes(raw.spawn_code)
    )
      return null;
    const reader = raw.reader === null ? null : closedCustodyReaderFailure(raw.reader);
    if (raw.reader !== null && reader === null) return null;
    return {
      schema_version: 1,
      child_status: raw.child_status as number | null,
      child_signal: raw.child_signal,
      spawn_code: raw.spawn_code,
      reader,
    };
  } catch {
    return null;
  }
}

// Fixed OS reader, not a caller-supplied script or candidate process. All path
// input is inert UTF-8 JSON on stdin. This command never changes an ACL or owner.
const windowsCustodyReader = String.raw`
$ErrorActionPreference='Stop'
$phase='entry';$reason='os-read';$ordinal=-1;$kind='unknown';$principal='unknown';$rights=0
function Get-CustodyPrincipalClass([string]$Sid){
 switch -Regex ($Sid){
  '^S-1-1-0$'{return 'everyone'}
  '^S-1-5-11$'{return 'authenticated-users'}
  '^S-1-5-32-545$'{return 'builtin-users'}
  '^S-1-5-4$'{return 'interactive'}
  '^S-1-5-5-[0-9]+-[0-9]+$'{return 'logon-session'}
  '^S-1-3-0$'{return 'creator-owner'}
  default{return 'other'}
 }
}
function Refuse-Custody([string]$Reason){$script:reason=$Reason;throw 'Fixed Windows custody refused'}
try{
 if($PSVersionTable.PSVersion.Major -ne 7){Refuse-Custody 'runtime'}
 [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true)
 $phase='input'
 $inputPaths=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
 if($inputPaths -isnot [Array] -or $inputPaths.Count -lt 1 -or $inputPaths.Count -gt 4096){Refuse-Custody 'input'}
 $broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $trusted=@($broker,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
 $rows=@(foreach($entry in $inputPaths){
  $ordinal++;$phase='item';$kind='unknown';$principal='unknown';$rights=0
  if((($entry.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'file,path'){Refuse-Custody 'input'}
  if($entry.path -isnot [string] -or $entry.file -isnot [bool]){Refuse-Custody 'input'}
  $kind=$(if($entry.file){'file'}else{'directory'})
  $item=Get-Item -LiteralPath $entry.path -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -eq $entry.file){Refuse-Custody 'regular-path'}
  $phase='acl';$acl=Get-Acl -LiteralPath $entry.path
  $phase='owner';$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -notin $trusted){$principal=Get-CustodyPrincipalClass $owner;Refuse-Custody 'owner'}
  $replace=[Security.AccessControl.FileSystemRights]'Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  if($entry.file){$replace=$replace -bor [Security.AccessControl.FileSystemRights]'Write'}
  $phase='rules'
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
   if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
      $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $replace) -ne 0 -and
      $rule.IdentityReference.Value -notin $trusted){
    $principal=Get-CustodyPrincipalClass $rule.IdentityReference.Value
    if(($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -ne 0){$rights=$rights -bor 1}
    if(($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0){$rights=$rights -bor 2}
    if(($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0){$rights=$rights -bor 4}
    if(($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0){$rights=$rights -bor 8}
    if($entry.file -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0){$rights=$rights -bor 16}
    Refuse-Custody 'writer'
   }
  }
  [ordered]@{path=$entry.path;owner=$owner;sddl=$acl.Sddl}
 })
 $phase='complete'
 ConvertTo-Json -InputObject ([ordered]@{schema_version=1;broker_sid=$broker;rows=$rows}) -Depth 4 -Compress
}catch{
 # Closed diagnostics only: no input path, SID, SDDL, exception text or stack.
 $record=[ordered]@{schema_version=1;reason=$reason;phase=$phase;ordinal=$(if($ordinal -ge 0){$ordinal}else{$null});kind=$kind;principal_class=$principal;rights=$rights}
 [Console]::Error.WriteLine('portcove-native-custody-failure:'+($record|ConvertTo-Json -Compress))
 exit 1
}
`;
function inspectWindowsCustody(
  files: readonly string[],
  sourceSystemImages = false,
): NativeRuntimeCustody {
  assert.ok(files.length > 0 && files.length <= 128, "bounded Windows custody inputs required");
  const inventory = new Map<string, { file: boolean; identity: string }>();
  const identity = (filename: string, regular: boolean) => {
    const info = lstatSync(filename, { bigint: true });
    assert.ok(!info.isSymbolicLink(), "linked Windows runtime refused");
    assert.ok(
      regular
        ? info.isFile() &&
            (sourceSystemImages &&
            Object.values(windowsSourceSystemExecutables).some((value) => value === filename)
              ? info.nlink > 0n
              : info.nlink === 1n)
        : info.isDirectory(),
      `Windows runtime requires regular single-link files and directory ancestry: ${JSON.stringify({ path: filename, file: info.isFile(), directory: info.isDirectory(), links: String(info.nlink) })}`,
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
  const reader = windowsSourceSystemExecutables.powershell;
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
    const detail = readWindowsCustodyFailure(error);
    throw Object.assign(new Error("Windows custody OS read refused", { cause: error }), {
      code: "ERR_WINDOWS_CUSTODY_REFUSED",
      windows_custody: detail,
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

/** Fixed host-image inputs only. NTFS links share file ACLs; retain exact link
 * count/identity/ACL/ancestry. Controller inputs keep their single-link rule. */
export function inspectWindowsSourceSystemCustody(): NativeRuntimeCustody {
  assert.ok(
    process.platform === "win32" && process.arch === "x64",
    "fixed Windows source-system custody required",
  );
  return inspectWindowsCustody(Object.values(windowsSourceSystemExecutables), true);
}

export function recheckWindowsSourceSystemCustody(retained: NativeRuntimeCustody) {
  assert.deepEqual(
    inspectWindowsSourceSystemCustody(),
    retained,
    "original Windows source-system custody changed",
  );
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
