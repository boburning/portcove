param(
  [Parameter(Mandatory=$true)][string]$RunRoot,
  [Parameter(Mandatory=$true)][ValidateSet('probe','reader-fixture','fixture','codex')][string]$Mode,
  [switch]$ReadOnlyStorage,
  [switch]$StorageProbe,
  [string]$BoundedStorageConfiguration
)
$ErrorActionPreference='Stop'
function Write-StoragePreflightCapture([string]$Root,$ProcessResult) {
  $capture=[Text.Encoding]::UTF8.GetBytes((@{schema_version=1;preflight=$ProcessResult.Storage}|ConvertTo-Json -Depth 7))
  if($capture.Length -gt 32768) { throw 'storage preflight capture exceeds bound' }
  $file=[IO.File]::Open((Join-Path $Root 'capture/storage-preflight.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try { $file.Write($capture);$file.Flush($true) } finally { $file.Dispose() }
  $storage=$ProcessResult.Storage
  $summary=[ordered]@{Passed=$storage.Passed;IdentityVerified=$storage.IdentityVerified;Reverted=$storage.Reverted;BypassTraverseEnabled=$storage.BypassTraverseEnabled;Error=$storage.Error;NativeErrorCode=$storage.NativeErrorCode;CaptureSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($capture)).ToLowerInvariant();Paths=@($storage.Paths|Select-Object Path,Attributes,BrokerAttributes,BrokerMetadataError,MetadataError,DescriptorError)}
  $processReceipt=$ProcessResult|Select-Object * -ExcludeProperty Storage
  $processReceipt|Add-Member -NotePropertyName Storage -NotePropertyValue $summary
  return $processReceipt
}
function Open-ObservationHandoff([string]$Root,[string]$ConfigurationHash,[string]$NativeHash,[string]$LauncherHash,[string]$OperatorHash,[string]$QualifierHash,[string]$OwnerSid) {
  $lockPath=Join-Path $Root 'completion-operation.lock'
  if((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'observation operator lock replaced' }
  $gate=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {
    # Retain the same lock even for legacy storage with no observation intent.
    # Preparation cannot archive its marker/attach between this read and launch.
    if(-not (Test-Path -LiteralPath (Join-Path $Root 'privilege-observation-intent.json'))) { return $gate }
    if(Test-Path -LiteralPath (Join-Path $Root 'privilege-observation-recovery-intent.json')) { throw 'observation recovery already claimed; no launch' }
    $records=@()
    foreach($name in @('privilege-observation-intent.json','privilege-observation-result.json')) {
      $file=Get-Item -LiteralPath (Join-Path $Root $name)
      if($file.Length -gt 8192 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'observation handoff record differs' }
      $records += Get-Content -Raw -LiteralPath $file.FullName|ConvertFrom-Json
    }
    $intent=$records[0];$ready=$records[1]
    foreach($record in @($intent,$ready)) {
      if($record.schema_version -ne 1 -or $record.owner_sid -ne $OwnerSid -or $record.source_revision -notmatch '^[a-f0-9]{40}$' -or $record.image -ne (Join-Path $Root 'reviewer.vhd') -or $record.configuration_sha256 -ne $ConfigurationHash -or $record.native_helper_sha256 -ne $NativeHash -or $record.launcher_sha256 -ne $LauncherHash -or $record.qualifier_sha256 -ne $QualifierHash -or $record.operator_helper_sha256 -ne $OperatorHash) { throw 'observation source/identity handoff differs' }
    }
    if($ready.ready -ne $true -or $null -ne $ready.provider_error -or $null -ne $ready.readback_error -or $ready.source_revision -ne $intent.source_revision) { throw 'observation preparation is not positively ready' }
    $archive=Get-Item -LiteralPath (Join-Path $Root 'reviewer-active.semantic-isolation-MdzaNi.retained.json')
    if(($archive.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne '09cf56df3f76d65cf442992a37eab3b5d2338e48c5b11ccba42611053b68edd5') { throw 'original marker archive differs' }
    return $gate
  } catch { $gate.Dispose();throw }
}
if($Mode -eq 'codex') { throw 'HOLD: reviewer writable profile storage and fixed read-only input reader are not yet enforced; credential provisioning cannot remove this hold' }
if($Mode -in @('fixture','reader-fixture') -and -not $ReadOnlyStorage) { throw 'inert actual-runtime fixture requires read-only LPAC preparation; no credentials' }
if($StorageProbe -and ($Mode -ne 'probe' -or -not $ReadOnlyStorage)) { throw 'native storage probe requires read-only preparation' }
if($BoundedStorageConfiguration -and (($Mode -notin @('fixture','reader-fixture') -and -not ($Mode -eq 'probe' -and $StorageProbe)) -or -not $ReadOnlyStorage)) { throw 'bounded writable differential is inert fixture only; production remains held' }
$runPath=[IO.Path]::GetFullPath($RunRoot)
if(-not [IO.Path]::IsPathFullyQualified($RunRoot) -or -not (Test-Path -LiteralPath (Join-Path $runPath '.portcove-semantic-review-owned') -PathType Leaf)) { throw 'trusted owned run root required' }
foreach($prior in @('capture/isolation.json','capture/process.identity.txt','capture/stdout.jsonl','capture/stderr.txt','capture/storage-preflight.json')) { if(Test-Path -LiteralPath (Join-Path $runPath $prior)) { throw 'prior attempt evidence exists; explicit readback/recovery required, never overwrite' } }
$required=@('runtime','inputs','work','capture','sensitive')
$nativeBytes=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'fixtures/semantic-review-appcontainer.cs.txt'))
$nativeSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($nativeBytes)).ToLowerInvariant()
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString($nativeBytes))
$boundaryLocks=[PortcoveReviewContainer]::LockBoundary($runPath)
$observationLock=$null
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
$profileLocks=$null
$tempLocks=$null
$boundedVolume=$null
$activeMarker=$null
$activeMarkerPath=$null
$boundedMount=$null
$boundedGuid=$null
$dataRoot=$null
$boundedGrantsRemoved=$false
$storagePreflightPaths=@()
$cleanupErrors=[Collections.Generic.List[string]]::new()
try {
  if($ReadOnlyStorage) {
    $profilePath=[IO.Path]::GetFullPath($reviewContainer.Folder)
    $expectedProfile=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ("Packages/"+$reviewContainer.Name)
    if(-not ($profilePath -eq $expectedProfile -or $profilePath.StartsWith($expectedProfile+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))) { throw 'unexpected disposable profile path' }
    # The API returns packageRoot/AC; seal the entire fresh owned package, not
    # only AC. Build new DACLs: removal of the profile's critical ACE is not
    # reliable through FileSystemAccessRule.RemoveAccessRuleSpecific.
    $profileLocks=[PortcoveReviewContainer]::LockBoundary($expectedProfile,1024,16)
    foreach($lockedPath in $profileLocks.Paths) {
      if($lockedPath -ne $expectedProfile -and -not $lockedPath.StartsWith($expectedProfile+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { continue }
      $entry=Get-Item -LiteralPath $lockedPath -Force
      if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'disposable profile reparse point refused' }
      $inheritance=if($entry.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
      $entryAcl=if($entry.PSIsContainer){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
      $entryAcl.SetOwner($identity)
      $entryAcl.SetAccessRuleProtection($true,$false)
      foreach($sid in @($identity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $entryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inheritance,'None','Allow'))
      }
      $entryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ReadPermissions',$inheritance,'None','Allow'))
      $entryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($reviewContainer.Sid),'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership',$inheritance,'None','Deny'))
      $entryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($reviewContainer.Sid),'ReadAndExecute',$inheritance,'None','Allow'))
      # Only owner/DACL sections are modified; mandatory integrity/SACL state is
      # not replaced. Compare raw ACEs so critical flags cannot disappear in a
      # high-level AccessRule projection.
      Set-Acl -LiteralPath $entry.FullName -AclObject $entryAcl
      $expectedDacl=[Security.AccessControl.RawSecurityDescriptor]::new($entryAcl.Sddl).DiscretionaryAcl
      $actual=[Security.AccessControl.RawSecurityDescriptor]::new((Get-Acl -LiteralPath $entry.FullName).Sddl)
      if(-not ($actual.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or $actual.DiscretionaryAcl.Count -ne $expectedDacl.Count) { throw 'profile DACL readback differs' }
      for($i=0;$i -lt $expectedDacl.Count;$i++) {
        $wanted=[byte[]]::new($expectedDacl[$i].BinaryLength);$expectedDacl[$i].GetBinaryForm($wanted,0)
        $observed=[byte[]]::new($actual.DiscretionaryAcl[$i].BinaryLength);$actual.DiscretionaryAcl[$i].GetBinaryForm($observed,0)
        if([Convert]::ToBase64String($wanted) -ne [Convert]::ToBase64String($observed)) { throw 'profile ACE readback differs' }
      }
    }
    & icacls.exe $runPath /grant '*S-1-3-4:(OI)(CI)(RC)' > (Join-Path $runPath 'capture/owner-rights-acl.txt')
    if($LASTEXITCODE -ne 0) { throw 'owner rights restriction failed' }
    & icacls.exe $runPath /deny "*$($reviewContainer.Sid):(OI)(CI)(W,D,DC,WDAC,WO)" > (Join-Path $runPath 'capture/read-only-acl.txt')
    if($LASTEXITCODE -ne 0) { throw 'read-only run boundary failed' }
  }
  & icacls.exe $runPath /grant "*$($reviewContainer.Sid):(RX)" > (Join-Path $runPath 'capture/root-acl.txt')
  if($LASTEXITCODE -ne 0) { throw 'root traversal ACL failed' }
  foreach($directory in @('runtime','inputs','work')) {
    $directoryPath=Join-Path $runPath $directory
    $rights=if($directory -eq 'work' -and -not $ReadOnlyStorage){'M'}else{'RX'}
    & icacls.exe $directoryPath /grant "*$($reviewContainer.Sid):(OI)(CI)$rights" > (Join-Path $runPath "capture/$directory-acl.txt")
    if($LASTEXITCODE -ne 0) { throw 'review directory ACL failed' }
  }
  if($StorageProbe) {
    $canaryPath=Join-Path $runPath 'inputs/allapps-only.txt'
    $canaryAcl=[Security.AccessControl.FileSecurity]::new()
    $canaryAcl.SetOwner($identity)
    $canaryAcl.SetAccessRuleProtection($true,$false)
    $canaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'))
    $canaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','Allow'))
    $canaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-3-4'),'ReadPermissions','Allow'))
    $canaryAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-15-2-1'),'ReadAndExecute','Allow'))
    Set-Acl -LiteralPath $canaryPath -AclObject $canaryAcl
  }
  $workPath=Join-Path $runPath 'work'
  $homePath=$workPath
  $tempPath=$workPath
  if($BoundedStorageConfiguration) {
    $storageConfig=Get-Content -Raw -LiteralPath $BoundedStorageConfiguration | ConvertFrom-Json
    $storageHash=(Get-FileHash -LiteralPath $BoundedStorageConfiguration -Algorithm SHA256).Hash.ToLowerInvariant()
    $storageRoot=[IO.Path]::GetFullPath($storageConfig.root)
    $allowedStorage=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../work/slice4'))+[IO.Path]::DirectorySeparatorChar
    if($storageConfig.schema_version -ne 1 -or $storageConfig.maximum_bytes -ne 536870912 -or $storageConfig.credentials -ne 'none' -or $storageConfig.owner_sid -ne $identity.Value -or -not $storageRoot.StartsWith($allowedStorage,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($storageRoot) -notmatch '^semantic-storage-[a-f0-9]{32}$') { throw 'fixed local storage configuration differs' }
    if([IO.File]::ReadAllText((Join-Path $storageRoot '.portcove-semantic-storage-owned')) -ne $storageHash) { throw 'operator storage ownership unavailable' }
    $storage=Get-Content -Raw -LiteralPath (Join-Path $storageRoot 'storage.json') | ConvertFrom-Json
    $boundedMount=Join-Path $storageRoot 'data'
    if($storage.configuration_sha256 -ne $storageHash -or $storage.mount -ne $boundedMount -or $storage.maximum_bytes -ne 536870912 -or $storage.credentials -ne 'none') { throw 'operator storage receipt differs' }
    $observationLock=Open-ObservationHandoff $storageRoot $storageHash $nativeSha ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()) ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'prepare-semantic-observation.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()) ((Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'qualify-semantic-isolation.mts') -Algorithm SHA256).Hash.ToLowerInvariant()) $identity.Value
    $boundedVolume=[PortcoveReviewContainer+BoundedVolume]::Open($boundedMount,$storage.volume_guid)
    $boundedGuid=$boundedVolume.Guid
    $activeMarkerPath=Join-Path $storageRoot 'reviewer-active.json'
    $activeMarker=[IO.File]::Open($activeMarkerPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    $activeBytes=[Text.Encoding]::UTF8.GetBytes((@{run_root=$runPath;profile_sid=$reviewContainer.Sid} | ConvertTo-Json -Compress))
    $activeMarker.Write($activeBytes,0,$activeBytes.Length);$activeMarker.Flush($true)
    $dataRoot=Join-Path $boundedMount ([IO.Path]::GetFileName($runPath))
    New-Item -ItemType Directory -Path $dataRoot -ErrorAction Stop | Out-Null
    foreach($name in @('work','home','temp')) { New-Item -ItemType Directory -Path (Join-Path $dataRoot $name) -ErrorAction Stop | Out-Null }
    & icacls.exe $dataRoot /grant '*S-1-3-4:(OI)(CI)(RC)' "*$($reviewContainer.Sid):(OI)(CI)M" > (Join-Path $runPath 'capture/bounded-data-acl.txt')
    if($LASTEXITCODE -ne 0) { throw 'bounded reviewer data grant failed' }
    $workPath=Join-Path $dataRoot 'work';$homePath=Join-Path $dataRoot 'home';$tempPath=Join-Path $dataRoot 'temp'
    & icacls.exe $dataRoot /setintegritylevel '(OI)(CI)L' > (Join-Path $runPath 'capture/bounded-data-integrity.txt')
    if($LASTEXITCODE -ne 0) { throw 'bounded data integrity label failed' }
    $storagePreflightPaths=@($boundedMount,$dataRoot,$homePath,$workPath,$tempPath)
  }
  if($ReadOnlyStorage) {
    # Observed Win32 AppContainer environment rewriting derives TEMP from the
    # supplied LOCALAPPDATA. Materialize that exact owned route before launch.
    $redirectedTemp=$homePath
    foreach($segment in @('Packages',$reviewContainer.Name,'AC','Temp')) {
      $redirectedTemp=Join-Path $redirectedTemp $segment
      New-Item -ItemType Directory -Path $redirectedTemp -ErrorAction Stop | Out-Null
    }
    if(-not $BoundedStorageConfiguration) { $tempLocks=[PortcoveReviewContainer]::LockBoundary($workPath,1024,16) }
  }
  & icacls.exe $workPath /setintegritylevel '(OI)(CI)L' > (Join-Path $runPath 'capture/low-integrity-acl.txt')
  if($LASTEXITCODE -ne 0) { throw 'low integrity work ACL failed' }
  $inputs=Join-Path $runPath 'inputs'
  $runtime=Join-Path $runPath 'runtime'
  if($Mode -eq 'probe') {
    if($StorageProbe) { $executable=Join-Path $runtime 'storage-probe.exe'; $arguments=@($runPath) }
    else { $executable=Join-Path $runtime 'node.exe'; $arguments=@('--preserve-symlinks','--preserve-symlinks-main',(Join-Path $inputs 'probe.mts'),$runPath) }
    $timeout=if($StorageProbe -and $BoundedStorageConfiguration){60000}else{30000}
  } elseif($Mode -eq 'reader-fixture') {
    $readerLaunch=Get-Content -Raw -LiteralPath (Join-Path $inputs 'reader-launch.json') | ConvertFrom-Json
    if($readerLaunch.schema_version -ne 1 -or $readerLaunch.index_sha256 -notmatch '^[a-f0-9]{64}$') { throw 'fixed reader fixture identity unavailable' }
    $executable=Join-Path $runtime 'node.exe'
    $arguments=@('--preserve-symlinks','--preserve-symlinks-main',(Join-Path $runtime 'release-semantic-reader-server.mts'),(Join-Path $inputs 'reader-index.json'),$readerLaunch.index_sha256)
    $timeout=60000
  } else {
    $executable=Join-Path $runtime 'codex.exe'
    $arguments=@('exec','--ephemeral','--ignore-user-config','--ignore-rules','--sandbox','read-only','--skip-git-repo-check','--json','--model','gpt-6.1-sol','--config','model_reasoning_effort="high"','--output-schema',(Join-Path $inputs 'result-schema.json'),'--cd',$workPath,'-')
    $arguments += @('--config','features.shell_tool=false','--config','features.view_image=false','--config','features.browser_use=false','--config','features.browser_use_external=false','--config','features.in_app_browser=false','--config','features.code_mode_host=false','--config','features.multi_agent=false','--config','features.multi_agent_v2=false','--config','features.unified_exec=false','--config','features.skill_search=false','--config','features.skill_mcp_dependency_install=false','--config','features.remote_plugin=false','--config','features.unbounded_connection_retries=false','--config','features.apps=false','--config','features.plugins=false','--config','web_search="disabled"','--config','project_doc_max_bytes=0','--config','cli_auth_credentials_store="file"')
    if(Test-Path -LiteralPath (Join-Path $inputs 'reader-launch.json')) {
      $readerLaunch=Get-Content -Raw -LiteralPath (Join-Path $inputs 'reader-launch.json') | ConvertFrom-Json
      if($readerLaunch.schema_version -ne 1 -or $readerLaunch.index_sha256 -notmatch '^[a-f0-9]{64}$') { throw 'fixed reader launch identity unavailable' }
      $readerCommand=(Join-Path $runtime 'node.exe').Replace('\','/') | ConvertTo-Json -Compress
      $readerArguments=@('--preserve-symlinks','--preserve-symlinks-main',(Join-Path $runtime 'release-semantic-reader-server.mts').Replace('\','/'),(Join-Path $inputs 'reader-index.json').Replace('\','/'),$readerLaunch.index_sha256) | ConvertTo-Json -Compress
      $arguments += @('--config',("mcp_servers.portcove_frozen_bundle.command="+$readerCommand),'--config',("mcp_servers.portcove_frozen_bundle.args="+$readerArguments),'--config','mcp_servers.portcove_frozen_bundle.enabled_tools=["list","read","search"]','--config','mcp_servers.portcove_frozen_bundle.startup_timeout_sec=15','--config','mcp_servers.portcove_frozen_bundle.tool_timeout_sec=30')
    } elseif($Mode -eq 'codex') { throw 'fixed reader materialization required' }
    $timeout=if($Mode -eq 'fixture'){60000}else{1800000}
  }
  $environment=@("SystemRoot=$env:SystemRoot","WINDIR=$env:SystemRoot","TEMP=$tempPath","TMP=$tempPath","LOCALAPPDATA=$homePath","PATH=$runtime","PORTCOVE_REVIEW_INPUTS=$inputs")
  if($ReadOnlyStorage) { $environment += @("PORTCOVE_REVIEW_PROFILE=$profilePath","CODEX_HOME=$homePath","USERPROFILE=$homePath","APPDATA=$homePath") }
  if($BoundedStorageConfiguration) { $environment += "PORTCOVE_REVIEW_BOUNDED_DATA=$dataRoot" }
  if($Mode -eq 'fixture') { $environment += @('RUST_BACKTRACE=1','RUST_LOG=codex_app_server_client=debug,codex_core=debug,codex_exec=debug') }
  $result=[PortcoveReviewContainer]::Run($reviewContainer,$executable,[string[]]$arguments,$workPath,(Join-Path $inputs 'instructions.txt'),(Join-Path $runPath 'capture/stdout.jsonl'),(Join-Path $runPath 'capture/stderr.txt'),[string[]]$environment,$timeout,[bool]$ReadOnlyStorage,[string[]]$storagePreflightPaths)
} finally {
  try { if($StorageProbe -and $profilePath -and $null -ne $result -and $result.TreeEmpty) {
    [ordered]@{profile_path=$profilePath;sddl=(Get-Acl -LiteralPath $profilePath).Sddl;native_probe_file_present=(Test-Path -LiteralPath (Join-Path $profilePath 'native-profile.data'))} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runPath 'capture/profile-storage-readback.json') -Encoding utf8NoBOM
  } } catch { $cleanupErrors.Add('native profile readback unavailable') }
  try { if($null -ne $activeMarker) { $activeMarker.Dispose() } } catch { $cleanupErrors.Add('active marker handle cleanup failed') }
  # Never traverse reviewer-controlled contents to repair ACLs. Retain the
  # volume and active marker for identity-checked operator detach instead.
  try { if($null -ne $boundedVolume) { $boundedVolume.Dispose() } } catch { $cleanupErrors.Add('bounded volume handle cleanup failed') }
  try { if($null -ne $tempLocks) { $tempLocks.Dispose() } } catch { $cleanupErrors.Add('redirected temporary path lock cleanup failed') }
  try { if($null -ne $profileLocks) { $profileLocks.Dispose() } } catch { $cleanupErrors.Add('profile lock cleanup failed') }
  try { $reviewContainer.Dispose(); $deleted=$true } catch { $cleanupErrors.Add('profile deletion failed') }
  try {
    if($activeMarkerPath -and $null -ne $result -and $result.TreeEmpty -and $deleted -and $boundedGrantsRemoved -and $cleanupErrors.Count -eq 0) { Remove-Item -LiteralPath $activeMarkerPath -ErrorAction Stop }
  } catch { $cleanupErrors.Add('active marker retained; explicit recovery required') }
  $processReceipt=$result
  try { if($null -ne $result -and $null -ne $result.Storage) { $processReceipt=Write-StoragePreflightCapture $runPath $result } }
  catch { $processReceipt=$result|Select-Object * -ExcludeProperty Storage;$cleanupErrors.Add('storage preflight capture unavailable; retain original state') }
  try {
    [ordered]@{schema_version=1;mode=$Mode;native_helper_sha256=$nativeSha;read_only_storage=[bool]$ReadOnlyStorage;bounded_mount=$boundedMount;bounded_volume_guid=$boundedGuid;bounded_grants_removed=$boundedGrantsRemoved;cleanup_errors=@($cleanupErrors);profile_name=$reviewContainer.Name;expected_sid=$reviewContainer.Sid;profile_deleted=$deleted;broker_sid=$identity.Value;process=$processReceipt;qualification='OS containment/process evidence only; not semantic acceptance or credential authority'} | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $runPath 'capture/isolation.json') -Encoding utf8NoBOM
  } catch { throw 'isolation receipt unavailable; preserve all state for recovery' }
}
if($cleanupErrors.Count -ne 0 -or -not $result.TreeEmpty -or $result.ForcedTermination -or $result.ExitCode -ne 0) { throw 'reviewer failed or required forced tree termination; credentials remain withheld' }
} finally { try { if($null -ne $observationLock) { $observationLock.Dispose() } } finally { $boundaryLocks.Dispose() } }
