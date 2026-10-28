import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

void test(
  "historical bootstrap refuses changed identities and shared browser profiles before installation",
  {
    skip: process.platform !== "win32" ? "requires Windows argument API and path semantics" : false,
    timeout: 45000,
  },
  (t) => {
    const root = disposableDirectory(t, path.join(os.tmpdir(), "historical-bootstrap-controls-"));
    const script = path.join(root, "controls.ps1");
    writeFileSync(
      script,
      String.raw`
param([string]$Source,[string]$Root)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Installer source does not parse'}
foreach($name in @('Assert-NoReparseAncestry','Get-ComparableWindowsPath','Read-HistoricalBootstrapManifest','Get-HistoricalWebViewProfile')) {
 $definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
 if($definitions.Count -ne 1){throw "Missing/duplicate actual function $name"}
 . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$package=Join-Path $Root 'inert.exe';[IO.File]::WriteAllText($package,'inert fixture, never executed')
$manifest=Join-Path $Root 'manifest.json'
$valid=@{schema_version=1;version='0.1.0-alpha.2';source_commit=('a'*40);installer_path=$package;installer_sha256=(Get-FileHash $package).Hash.ToLowerInvariant();installer_bytes=(Get-Item $package).Length;release_tag='v0.1.0-alpha.2';release_asset_id=1;release_url='https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2'}
$valid|ConvertTo-Json|Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
$accepted=Read-HistoricalBootstrapManifest $manifest
if($accepted.version -cne $valid.version){throw 'Valid historical version refused'}
$cases=@(
 @{installer_sha256=('0'*64)},@{installer_bytes=1},@{installer_bytes=536870913},
 @{installer_path='relative.exe'},@{source_commit='missing'},@{schema_version='1'},
 @{release_asset_id=$true},@{version='00.1.0'},@{version='0.1.0;command'},
 @{release_url='https://example.invalid/release'},@{version=@('0.1.0')},@{unexpected='field'}
)
foreach($change in $cases){
 $input=$valid.Clone();foreach($key in $change.Keys){$input[$key]=$change[$key]}
 $input|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
 $rejected=$false;try{$null=Read-HistoricalBootstrapManifest $manifest}catch{$rejected=$true}
 if(-not $rejected){throw "Malformed manifest accepted: $($change.Keys -join ',')"}
}
[IO.File]::WriteAllBytes($manifest,[byte[]]::new(65537))
try{$null=Read-HistoricalBootstrapManifest $manifest;throw 'oversize accepted'}catch{if($_.Exception.Message -eq 'oversize accepted'){throw}}
$valid|ConvertTo-Json|Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
[IO.File]::WriteAllText($package,'changed bytes after identity was recorded')
try{$null=Read-HistoricalBootstrapManifest $manifest;throw 'changed package accepted'}catch{if($_.Exception.Message -eq 'changed package accepted'){throw}}

# Controlled CIM replies exercise the actual observer against held live process
# handles. These are refusal/argument fixtures, never native browser evidence.
$ProcessIdentityClockToleranceMilliseconds=1000
$parent=[Diagnostics.Process]::GetCurrentProcess();$null=$parent.Handle
$profile=Join-Path $Root 'private profile';[IO.Directory]::CreateDirectory($profile)|Out-Null
$script:reply=@()
function Get-CimInstance {param($ClassName,$Filter,$OperationTimeoutSec) $script:reply}
function Set-Reply([string]$Command) {
 $script:reply=@([pscustomobject]@{ProcessId=$parent.Id;CreationDate=$parent.StartTime;ExecutablePath=$parent.Path;CommandLine=$Command})
}
Set-Reply ('browser.exe --user-data-dir="'+$profile+'"')
$observed=@(Get-HistoricalWebViewProfile $parent $profile)
if($observed.Count -ne 1 -or $observed[0].user_data_directory -cne $profile){throw 'Quoted private profile was not decoded'}
Set-Reply ('browser.exe --user-data-dir "'+$profile+'"')
$null=Get-HistoricalWebViewProfile $parent $profile
foreach($command in @('browser.exe','browser.exe --user-data-dir','browser.exe --user-data-dir=C:\shared',('browser.exe --user-data-dir="'+$profile+'" --user-data-dir="'+$profile+'"'))) {
 Set-Reply $command
 $rejected=$false;try{$null=Get-HistoricalWebViewProfile $parent $profile}catch{$rejected=$true}
 if(-not $rejected){throw 'Missing/duplicate/shared profile accepted'}
}
Set-Reply ('browser.exe --user-data-dir="'+$profile+'"');$script:reply[0].ExecutablePath='C:\different.exe'
try{$null=Get-HistoricalWebViewProfile $parent $profile;throw 'different image accepted'}catch{if($_.Exception.Message -eq 'different image accepted'){throw}}
$parent.Dispose()
'Historical manifest/profile refusal controls passed; no installer/application was executed'
`,
    );
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script,
        fileURLToPath(new URL("./test-windows-installer.ps1", import.meta.url)),
        root,
      ],
      {
        encoding: "utf8",
        timeout: 35000,
        maxBuffer: 65536,
      },
    );
    assert.equal(
      result.status,
      0,
      JSON.stringify({
        error: result.error?.message,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    assert.match(result.stdout, /Historical manifest\/profile refusal controls passed/u);
  },
);
