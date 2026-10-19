param(
 [ValidateSet('Inspect','Prepare','RecoverBeforeFixture')][string]$Operation='Inspect',
 [ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceRevision
)
# Exact, separately granted next observation only. No allocation/format/ACL path.
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $workspace 'work/slice4/semantic-storage-2fda9f572e3843b5b16190a100b5275c'
$image=Join-Path $root 'reviewer.vhd';$mount=Join-Path $root 'data'
$active=Join-Path $root 'reviewer-active.json'
$archive=Join-Path $root 'reviewer-active.semantic-isolation-MdzaNi.retained.json'
$oldMarkerHash='09cf56df3f76d65cf442992a37eab3b5d2338e48c5b11ccba42611053b68edd5'
$ownerSid='S-1-5-21-1007133822-4277289207-646028416-1001'
$diskId='6002248094AE6EFC7984F0EC20A288AC'
$volumeId='\\?\Volume{12961e64-153d-4f34-9ada-6f0dcdb1f392}\'
$configHash='4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db'
$nativeHash='1c7e886ed148e3e9b2ccf6ca2bb821dbe6f4552f280c65ea299fc59308a03cf6'
$launcherHash='0b37cd52e486320162f36e3f6bec68c6cb39769fafb55970951a175466716670'
$qualifierHash='15d1e751a4abbaffd3743043361714921486675bef34c59630f6ffb00d5c090b'
$intentPath=Join-Path $root 'privilege-observation-intent.json'
$resultPath=Join-Path $root 'privilege-observation-result.json'
function Assert-ObservationFile([string]$Path,[string]$Hash) {
 for($entry=Get-Item -LiteralPath $Path -Force;$null -ne $entry;$entry=if($entry -is [IO.FileInfo]){$entry.Directory}else{$entry.Parent}) {
  if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'observation record/source ancestry replaced' }
 }
 if((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'reviewed observation identity changed' }
}
foreach($entry in @(
 @((Join-Path $workspace 'docs/qualification/slice4-semantic-local-storage.proposed.json'),$configHash),
 @((Join-Path $workspace 'scripts/prepare-semantic-storage.ps1'),'fa61e13beb04e892c50c63b6158b2b880d3555b046bb802f6c22a9738ca90179'),
 @((Join-Path $root 'storage.json'),'e460767ea301dc5e8e7ac515d0e52a40622b10de031f63cdd3cd696174acaaec'),
 @((Join-Path $root 'completion-result.json'),'257e7ce199c1d89b7f24e325bc8479793c36578a08f56c29337ae17e73350015'),
 @((Join-Path $workspace 'work/slice4/semantic-isolation-ttTNEZ/capture/isolation.json'),'6e0df90d8548beab992da4b03fcebac791ba71497be3fd9eacfaa70f180f4ce8'),
 @((Join-Path $workspace 'work/slice4/semantic-bounded-storage-recovery-readback.json'),'12d8df568bfd44e49a8061eb07237e9868222490fa95240f4ccdca5119bd6701'),
 @((Join-Path $root 'observation-intent.json'),'52161d279b1bb8b4741ed1bac61d57f694de010d3c81053f2aa83c57558e0d5d'),
 @((Join-Path $root 'observation-result.json'),'a940573820f87cc2702ee5cc0e816e45fc6c327055c995292e4602ce0a9edfb1'),
 @((Join-Path $root 'reviewer-active.semantic-isolation-ttTNEZ.retained.json'),'0ab15171c42aa3ce88e410a58768fb329af24e516afb938fcb29da8dc56dc52a'),
 @((Join-Path $workspace 'work/slice4/semantic-isolation-MdzaNi/capture/isolation.json'),'1cce72f7715d044c61be1aaeaea5415d7486e5e23a2bef31d9a61341b2597d9a'),
 @((Join-Path $workspace 'work/slice4/next-observation-recovery-readback.json'),'8e6c2ffc9e62b6ce88dee01046c0d77fb16ca5259c19a3591202d5cacad7f807')
)) { Assert-ObservationFile $entry[0] $entry[1] }
$config=Get-Content -Raw -LiteralPath (Join-Path $workspace 'docs/qualification/slice4-semantic-local-storage.proposed.json')|ConvertFrom-Json
if($config.root -ne $root -or $config.owner_sid -ne $ownerSid -or $config.maximum_bytes -ne 536870912 -or $config.credentials -ne 'none' -or [IO.File]::ReadAllText((Join-Path $root '.portcove-semantic-storage-owned')) -ne $configHash) { throw 'fixed retained storage scope changed' }
for($entry=Get-Item -LiteralPath $image -Force;$null -ne $entry;$entry=if($entry -is [IO.FileInfo]){$entry.Directory}else{$entry.Parent}) { if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'image ancestry replaced' } }
$scriptHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
if($Operation -ne 'RecoverBeforeFixture') {
 foreach($entry in @(@((Join-Path $workspace 'scripts/fixtures/semantic-review-appcontainer.cs.txt'),$nativeHash),@((Join-Path $workspace 'scripts/semantic-review-sandbox.ps1'),$launcherHash),@((Join-Path $workspace 'scripts/qualify-semantic-isolation.mts'),$qualifierHash))) { Assert-ObservationFile $entry[0] $entry[1] }
}
function Write-ObservationRecord([string]$Path,$Record) {
 $bytes=[Text.Encoding]::UTF8.GetBytes(($Record|ConvertTo-Json -Depth 7))
 if($bytes.Length -gt 8192) { throw 'observation record bound exceeded' }
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try { $stream.Write($bytes);$stream.Flush($true) } finally { $stream.Dispose() }
}
function Get-ObservationImage {
 $images=@(Get-DiskImage -ImagePath $image -ErrorAction Stop)
 if($images.Count -ne 1 -or $images[0].ImagePath -ne $image -or $images[0].Size -ne 536870912 -or $images[0].FileSize -ne 536871424 -or $images[0].StorageType -ne 2) { throw 'retained observation image differs' }
 return $images[0]
}
function Get-ObservationDisk {
 $observed=Get-ObservationImage
 if($observed.Attached -ne $true) { throw 'exact observation attachment unavailable' }
 # DiskImage.Number can be absent. Select only the pinned opaque disk identity
 # and require its backing Location to match the exact image, never its number.
 $disks=@(Get-Disk -UniqueId $diskId -ErrorAction Stop)
 if($disks.Count -ne 1 -or $disks[0].UniqueId -ne $diskId -or $disks[0].Location -ne $image -or $disks[0].Size -ne 536870912 -or $disks[0].IsBoot -ne $false -or $disks[0].IsSystem -ne $false -or [string]$disks[0].BusType -ne 'File Backed Virtual' -or [string]$disks[0].PartitionStyle -ne 'GPT') { throw 'exact non-system observation disk/location differs; no numeric fallback' }
 return $disks[0]
}
function Confirm-ObservationMount {
 $disk=Get-ObservationDisk
 if($disk.IsReadOnly -ne $false) { throw 'observation storage is not writable as selected' }
 $parts=@(Get-Partition -Disk $disk -ErrorAction Stop)
 $reserved=@($parts|Where-Object { $_.Offset -eq 17408 -and $_.Size -eq 16759808 })
 $data=@($parts|Where-Object { $_.Offset -eq 16777216 -and $_.Size -eq 520028160 })
 if($parts.Count -ne 2 -or $reserved.Count -ne 1 -or $data.Count -ne 1 -or @($parts|Where-Object { $_.DiskId -ne $disk.Path }).Count) { throw 'observation partition association differs' }
 $volume=@(Get-Volume -Partition $data[0] -ErrorAction Stop)
 $mounted=@(Get-Volume -FilePath ($mount+'\') -ErrorAction Stop)
 if($volume.Count -ne 1 -or $mounted.Count -ne 1 -or $mounted[0].Path -ne $volumeId -or $volume[0].Path -ne $volumeId -or $volume[0].UniqueId -ne $volumeId -or $volume[0].FileSystem -ne 'NTFS' -or $volume[0].FileSystemLabel -ne 'PortcoveSemantic' -or $volume[0].Size -ne 520024064) { throw 'existing exact observation mount/NTFS volume unavailable' }
}
function Archive-ObservationMarker {
 if(Test-Path -LiteralPath $archive) { throw 'original marker archive already exists; no repeat preparation' }
 Assert-ObservationFile $active $oldMarkerHash
 $handle=[IO.File]::Open($active,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
 $handle.Dispose()
 # Both literal names share the verified same parent; never overwrite a target.
 [IO.File]::Move($active,$archive)
 Assert-ObservationFile $archive $oldMarkerHash
 if(Test-Path -LiteralPath $active) { throw 'marker archive transition ambiguous' }
}
if($Operation -eq 'Inspect') {
 if(Test-Path -LiteralPath $archive) { Assert-ObservationFile $archive $oldMarkerHash } else { Assert-ObservationFile $active $oldMarkerHash }
 [ordered]@{operation='Inspect';image=$image;operator_helper_sha256=$scriptHash;configuration_sha256=$configHash;native_helper_sha256=$nativeHash;launcher_sha256=$launcherHash;qualifier_sha256=$qualifierHash;old_marker_present=(Test-Path -LiteralPath $active);archive_present=(Test-Path -LiteralPath $archive);intent_present=(Test-Path -LiteralPath $intentPath);image_readback=(Get-ObservationImage|Select-Object ImagePath,Attached,Size);mutations='none';execution_grant='separately required'}|ConvertTo-Json -Depth 4
 exit 0
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne $ownerSid -or -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'same-owner explicitly granted elevated operator required' }
$lockPath=Join-Path $root 'completion-operation.lock'
if((Get-Item -LiteralPath $lockPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'observation operator lock replaced' }
$gate=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
 if($Operation -eq 'RecoverBeforeFixture') {
  $intentFile=Get-Item -LiteralPath $intentPath
  if($intentFile.Length -gt 8192 -or ($intentFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'observation intent is unavailable or replaced' }
  $intent=Get-Content -Raw -LiteralPath $intentPath|ConvertFrom-Json
  if($intent.schema_version -ne 1 -or $intent.operator_helper_sha256 -ne $scriptHash -or $intent.configuration_sha256 -ne $configHash -or $intent.owner_sid -ne $ownerSid -or $intent.image -ne $image) { throw 'actual observation intent differs' }
  if(Test-Path -LiteralPath $active) { Assert-ObservationFile $active $oldMarkerHash }
  if(Test-Path -LiteralPath $archive) { Assert-ObservationFile $archive $oldMarkerHash }
  if((Test-Path -LiteralPath $active) -eq (Test-Path -LiteralPath $archive)) { throw 'original marker state missing or conflicting; reconcile before mutation' }
  Write-ObservationRecord (Join-Path $root 'privilege-observation-recovery-intent.json') @{schema_version=1;observed_at=[DateTime]::UtcNow.ToString('o');operator_helper_sha256=$scriptHash;image=$image;scope='one exact-image detach before new fixture ownership'}
  if(-not (Test-Path -LiteralPath $active)) { Write-ObservationRecord $active @{kind='observation-recovery-before-fixture';operator_helper_sha256=$scriptHash;fixture_started=$false} }
  $providerError=$null;$readbackError=$null;$after=@()
  try { if((Get-ObservationImage).Attached -eq $true) { $null=Get-ObservationDisk;Dismount-DiskImage -ImagePath $image -ErrorAction Stop|Out-Null } } catch { $providerError=$_.Exception.Message }
  try { $after=@(Get-ObservationImage) } catch { $readbackError=$_.Exception.Message }
  $detached=$after.Count -eq 1 -and $after[0].Attached -eq $false
  $markerRetained=$false
  try { if(Test-Path -LiteralPath $archive) { Assert-ObservationFile $archive $oldMarkerHash } else { Assert-ObservationFile $active $oldMarkerHash };$markerRetained=$true } catch { $readbackError=$_.Exception.Message }
  $record=@{schema_version=1;observed_at=[DateTime]::UtcNow.ToString('o');image=$image;detached_observed=$detached;provider_error=$providerError;readback_error=$readbackError;backing_file_retained=(Test-Path -LiteralPath $image);markers_retained=$markerRetained;automatic_retry=$false;fixture_started=$false}
  Write-ObservationRecord (Join-Path $root 'privilege-observation-recovery-result.json') $record
  $record|ConvertTo-Json
  if(-not $detached -or -not $record.backing_file_retained -or -not $markerRetained -or $readbackError) { throw 'recovery unconfirmed; retain state and reconcile actual readback' }
  exit 0
 }
 if(-not $ExpectedSourceRevision) { throw 'actual separately reviewed source revision required' }
 $taskSourceHead=& git -C $workspace rev-parse HEAD
 if($LASTEXITCODE -ne 0 -or $taskSourceHead -ne $ExpectedSourceRevision) { throw 'reviewed source revision differs' }
 $taskDirty=& git -C $workspace status --porcelain --untracked-files=no
 if($LASTEXITCODE -ne 0 -or $taskDirty) { throw 'tracked source differs from reviewed revision' }
 foreach($name in @('privilege-observation-intent.json','privilege-observation-result.json','privilege-observation-recovery-intent.json','privilege-observation-recovery-result.json')) { if(Test-Path -LiteralPath (Join-Path $root $name)) { throw 'observation already attempted; explicit readback/recovery, never repeat' } }
 if((Get-ObservationImage).Attached -ne $false) { throw 'observation must start from verified detached image' }
 if(Test-Path -LiteralPath $archive) { throw 'marker archive already exists' }
 Assert-ObservationFile $active $oldMarkerHash
 $common=@{schema_version=1;owner_sid=$ownerSid;source_revision=$taskSourceHead;image=$image;configuration_sha256=$configHash;native_helper_sha256=$nativeHash;launcher_sha256=$launcherHash;qualifier_sha256=$qualifierHash;operator_helper_sha256=$scriptHash}
 $intent=$common.Clone();$intent.observed_at=[DateTime]::UtcNow.ToString('o');$intent.phase='detached-before-marker-archive';$intent.old_marker_sha256=$oldMarkerHash
 Write-ObservationRecord $intentPath $intent
 $validated=$false;$stage='intent-written';$providerError=$null;$readbackError=$null;$after=@()
 try {
  Archive-ObservationMarker;$stage='old-marker-archived'
  Mount-DiskImage -ImagePath $image -NoDriveLetter -ErrorAction Stop|Out-Null;$stage='image-attached'
  Confirm-ObservationMount;$validated=$true;$stage='exact-storage-readback'
 } catch { $providerError=$_.Exception.Message }
 try { $after=@(Get-ObservationImage) } catch { $readbackError=$_.Exception.Message }
 $record=$common.Clone();$record.observed_at=[DateTime]::UtcNow.ToString('o');$record.stage=$stage;$record.provider_error=$providerError;$record.readback_error=$readbackError
 $record.ready=$validated -and $null -eq $providerError -and $null -eq $readbackError -and $after.Count -eq 1 -and $after[0].Attached -eq $true
 $record.readback=@($after|Select-Object ImagePath,Attached,Size,DevicePath);$record.old_marker_archive=$archive;$record.old_marker_sha256=$oldMarkerHash
 $record.fixture_started=$false;$record.automatic_retry=$false;$record.created_image=$false;$record.initialized=$false;$record.partitioned=$false;$record.formatted=$false
 Write-ObservationRecord $resultPath $record
 $record|ConvertTo-Json -Depth 6
 if(-not $record.ready) { throw 'observation not positively prepared; retain partial effects and use matching recovery' }
} finally { $gate.Dispose() }
