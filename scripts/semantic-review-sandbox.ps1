param(
  [Parameter(Mandatory=$true)][string]$RunRoot,
  [Parameter(Mandatory=$true)][ValidateSet('probe','codex')][string]$Mode
)
$ErrorActionPreference='Stop'
if($Mode -eq 'codex') { throw 'HOLD: reviewer writable profile storage and fixed read-only input reader are not yet enforced; credential provisioning cannot remove this hold' }
$runPath=[IO.Path]::GetFullPath($RunRoot)
if(-not [IO.Path]::IsPathFullyQualified($RunRoot) -or -not (Test-Path -LiteralPath (Join-Path $runPath '.portcove-semantic-review-owned') -PathType Leaf)) { throw 'trusted owned run root required' }
$required=@('runtime','inputs','work','capture','sensitive')
Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'fixtures/semantic-review-appcontainer.cs.txt'))
$boundaryLocks=[PortcoveReviewContainer]::LockBoundary($runPath)
try {
foreach($entry in @((Get-Item -LiteralPath $runPath)) + @(Get-ChildItem -LiteralPath $runPath -Recurse -Force)) {
  if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse run boundary refused' }
}
foreach($directory in $required) { if(-not (Test-Path -LiteralPath (Join-Path $runPath $directory) -PathType Container)) { throw "missing owned directory $directory" } }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
Set-Acl -LiteralPath $runPath -AclObject $acl
# Remove inherited grants on owned descendants; no external or installed ACL is changed.
foreach($entry in Get-ChildItem -LiteralPath $runPath -Recurse -Force) {
  $childAcl=Get-Acl -LiteralPath $entry.FullName
  $childAcl.SetAccessRuleProtection($false,$false)
  foreach($rule in @($childAcl.Access | Where-Object { -not $_.IsInherited })) { $childAcl.RemoveAccessRuleSpecific($rule) }
  Set-Acl -LiteralPath $entry.FullName -AclObject $childAcl
}
$reviewContainer=[PortcoveReviewContainer+Profile]::new()
$result=$null
$deleted=$false
try {
  & icacls.exe $runPath /grant "*$($reviewContainer.Sid):(RX)" > (Join-Path $runPath 'capture/root-acl.txt')
  if($LASTEXITCODE -ne 0) { throw 'root traversal ACL failed' }
  foreach($directory in @('runtime','inputs','work')) {
    $directoryPath=Join-Path $runPath $directory
    $rights=if($directory -eq 'work'){'M'}else{'RX'}
    & icacls.exe $directoryPath /grant "*$($reviewContainer.Sid):(OI)(CI)$rights" > (Join-Path $runPath "capture/$directory-acl.txt")
    if($LASTEXITCODE -ne 0) { throw 'review directory ACL failed' }
  }
  $workPath=Join-Path $runPath 'work'
  & icacls.exe $workPath /setintegritylevel '(OI)(CI)L' > (Join-Path $runPath 'capture/low-integrity-acl.txt')
  if($LASTEXITCODE -ne 0) { throw 'low integrity work ACL failed' }
  $inputs=Join-Path $runPath 'inputs'
  $runtime=Join-Path $runPath 'runtime'
  if($Mode -eq 'probe') {
    $executable=Join-Path $runtime 'node.exe'
    $arguments=@('--preserve-symlinks','--preserve-symlinks-main',(Join-Path $inputs 'probe.mts'),$runPath)
    $timeout=30000
  } else {
    $executable=Join-Path $runtime 'codex.exe'
    $arguments=@('exec','--ephemeral','--ignore-user-config','--ignore-rules','--sandbox','read-only','--skip-git-repo-check','--json','--model','gpt-6.1-sol','--config','model_reasoning_effort="high"','--output-schema',(Join-Path $inputs 'result-schema.json'),'--cd',$workPath,'-')
    $timeout=1800000
  }
  $environment=@("SystemRoot=$env:SystemRoot","WINDIR=$env:SystemRoot","TEMP=$workPath","TMP=$workPath","LOCALAPPDATA=$workPath","PATH=$runtime","PORTCOVE_REVIEW_INPUTS=$inputs")
  $result=[PortcoveReviewContainer]::Run($reviewContainer,$executable,[string[]]$arguments,$workPath,(Join-Path $inputs 'instructions.txt'),(Join-Path $runPath 'capture/stdout.jsonl'),(Join-Path $runPath 'capture/stderr.txt'),[string[]]$environment,$timeout)
} finally {
  try { $reviewContainer.Dispose(); $deleted=$true } finally {
    [ordered]@{schema_version=1;mode=$Mode;profile_name=$reviewContainer.Name;expected_sid=$reviewContainer.Sid;profile_deleted=$deleted;broker_sid=$identity.Value;process=$result;qualification='OS containment/process evidence only; not semantic acceptance or credential authority'} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $runPath 'capture/isolation.json') -Encoding utf8NoBOM
  }
}
if(-not $result.TreeEmpty -or $result.ForcedTermination -or $result.ExitCode -ne 0) { throw 'reviewer failed or required forced tree termination; credentials remain withheld' }
} finally { $boundaryLocks.Dispose() }
