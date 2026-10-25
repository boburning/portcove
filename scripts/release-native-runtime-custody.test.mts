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
} from "./release-native-runtime-custody.mts";

const windows = { skip: process.platform !== "win32" };
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
