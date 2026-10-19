param([ValidateSet('Inspect','Complete','RecoverIncomplete')][string]$Operation='Inspect')
# One retained, never-used fixture image. This is not a provisioning retry.
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root=Join-Path $workspace 'work/slice4/semantic-storage-2fda9f572e3843b5b16190a100b5275c'
$image=Join-Path $root 'reviewer.vhd';$mount=Join-Path $root 'data'
$configHash='4cdb2ef63a9c85a917b6d2f6962eddb6f40da561357433cde0bdd3d1e57ad0db'
$helperHash='fa61e13beb04e892c50c63b6158b2b880d3555b046bb802f6c22a9738ca90179'
$ownerSid='S-1-5-21-1007133822-4277289207-646028416-1001'
$diskId='6002248094AE6EFC7984F0EC20A288AC'
$volumeId='\\?\Volume{12961e64-153d-4f34-9ada-6f0dcdb1f392}\'
$intentPath=Join-Path $root 'completion-intent.json'
$resultPath=Join-Path $root 'completion-result.json'
foreach($entry in @(
 @((Join-Path $workspace 'docs/qualification/slice4-semantic-local-storage.proposed.json'),$configHash),
 @((Join-Path $workspace 'scripts/prepare-semantic-storage.ps1'),$helperHash),
 @((Join-Path $root 'intent.json'),'861af143466f953496640758df647f8448e2a1bff24b3777a2d6beeb1aa12ffa'),
 @((Join-Path $workspace 'work/slice4/semantic-storage-second-partial-detach-intent.json'),'4e3fcc609d2b6f98204f930bbe12bfe04479bb89e7c2b06830d869d29daa9ab8'),
 @((Join-Path $workspace 'work/slice4/semantic-storage-second-partial-detach-result.json'),'0f77c39489e3fbbfa6f0cc9679998e4469bc484b749540c4a8da4d5f5f9e5180')
)){
 if((Get-FileHash -LiteralPath $entry[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry[1]){throw 'reviewed preparation/recovery identity changed'}
}
foreach($target in @($root,$image,(Join-Path $root '.portcove-semantic-storage-owned'))){
 for($ancestor=Get-Item -LiteralPath $target -Force;$null -ne $ancestor;$ancestor=if($ancestor -is [IO.FileInfo]){$ancestor.Directory}else{$ancestor.Parent}){
  if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse ancestry refused'}
 }
}
if([IO.File]::ReadAllText((Join-Path $root '.portcove-semantic-storage-owned')) -ne $configHash -or (Get-Item -LiteralPath $image).Length -ne 536871424){throw 'retained image/marker changed'}
$scriptHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$config=Get-Content -Raw -LiteralPath (Join-Path $workspace 'docs/qualification/slice4-semantic-local-storage.proposed.json')|ConvertFrom-Json
if($config.root -ne $root -or $config.owner_sid -ne $ownerSid -or $config.maximum_bytes -ne 536870912 -or $config.credentials -ne 'none'){throw 'exact reviewed workspace scope differs'}
if($Operation -eq 'Inspect'){
 [ordered]@{operation=$Operation;image=$image;configuration_sha256=$configHash;helper_sha256=$helperHash;script_sha256=$scriptHash;disk_unique_id=$diskId;volume=$volumeId;mutations='none';next='one separately approved completion of retained image; no create/initialize/format'}|ConvertTo-Json
 exit 0
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne $ownerSid -or -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'same-owner explicitly authorized elevated operator required'}
if(Test-Path -LiteralPath (Join-Path $root 'reviewer-active.json')){throw 'reviewer ownership exists; use matching positive isolation receipt and RecoverDetach'}
function Write-NewCompletionRecord([string]$Path,$Value){
 $bytes=[Text.Encoding]::UTF8.GetBytes(($Value|ConvertTo-Json -Depth 8))
 $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Get-ExactImage {
 $images=@(Get-DiskImage -ImagePath $image -ErrorAction Stop)
 if($images.Count -ne 1 -or $images[0].ImagePath -ne $image -or $images[0].Size -ne 536870912 -or $images[0].FileSize -ne 536871424 -or $images[0].StorageType -ne 2){throw 'exact retained image differs'}
 return $images[0]
}
function Get-ExactDisk {
 $observed=Get-ExactImage
 if($observed.Attached -ne $true){throw 'retained attachment unavailable'}
 $disks=@($observed|Get-Disk -ErrorAction Stop)
 if($disks.Count -ne 1 -or $disks[0].UniqueId -ne $diskId -or $disks[0].Size -ne 536870912 -or $disks[0].IsBoot -ne $false -or $disks[0].IsSystem -ne $false -or [string]$disks[0].BusType -ne 'File Backed Virtual' -or [string]$disks[0].PartitionStyle -ne 'GPT'){throw 'retained non-system GPT disk differs; no numeric fallback'}
 return $disks[0]
}
function Get-PreparedPartition($Disk,[string]$ExpectedVolume,[switch]$RequireMount){
 $parts=@(Get-Partition -Disk $Disk -ErrorAction Stop)
 $reserved=@($parts|Where-Object { $_.Offset -eq 17408 -and $_.Size -eq 16759808 })
 $data=@($parts|Where-Object { $_.Offset -eq 16777216 -and $_.Size -eq 520028160 })
 if($parts.Count -ne 2 -or $reserved.Count -ne 1 -or $data.Count -ne 1 -or @($parts|Where-Object { $_.DiskId -ne $Disk.Path }).Count -ne 0){throw 'retained partition association differs'}
 $volumes=@(Get-Volume -Partition $data[0] -ErrorAction Stop)
 if($volumes.Count -ne 1 -or $volumes[0].Path -ne $ExpectedVolume -or $volumes[0].UniqueId -ne $ExpectedVolume -or $volumes[0].FileSystem -ne 'NTFS' -or $volumes[0].FileSystemLabel -ne 'PortcoveSemantic' -or $volumes[0].Size -ne 520024064){throw 'retained NTFS volume differs'}
 $paths=@($data[0].AccessPaths|Where-Object { $null -ne $_ })
 $expectedPaths=if($RequireMount){@($ExpectedVolume,($mount+'\'))}else{@($ExpectedVolume)}
 if($paths.Count -ne $expectedPaths.Count -or @($paths|Where-Object { $_ -notin $expectedPaths }).Count -ne 0 -or @($expectedPaths|Where-Object { $_ -notin $paths }).Count -ne 0){throw 'retained volume access paths differ'}
 return [pscustomobject]@{Partition=$data[0];Volume=$volumes[0]}
}
function Connect-PreparedPartition($Disk,[string]$ExpectedVolume){
 $prepared=Get-PreparedPartition $Disk $ExpectedVolume
 Add-PartitionAccessPath -InputObject $prepared.Partition -AccessPath ($mount+'\') -ErrorAction Stop
 return (Get-PreparedPartition $Disk $ExpectedVolume -RequireMount).Volume
}
function Open-CompletionOperationLock([string]$Root){
 $path=Join-Path $Root 'completion-operation.lock'
 if((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'operator lock replaced'}
 return [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
$operationLock=Open-CompletionOperationLock $root
try{
if(Test-Path -LiteralPath (Join-Path $root 'reviewer-active.json')){throw 'reviewer or recovery ownership exists'}
if($Operation -eq 'RecoverIncomplete'){
 $intent=Get-Content -Raw -LiteralPath $intentPath|ConvertFrom-Json
 if($intent.image -ne $image -or $intent.disk_unique_id -ne $diskId -or $intent.owner_sid -ne $ownerSid -or $intent.script_sha256 -ne $scriptHash -or $intent.configuration_sha256 -ne $configHash){throw 'completion intent differs'}
 $recoveryIntent=Join-Path $root 'completion-detach-intent.json'
 Write-NewCompletionRecord $recoveryIntent @{observed_at=[DateTime]::UtcNow.ToString('o');image=$image;script_sha256=$scriptHash;action='one exact-image detach before any reviewer ownership'}
 # Compete atomically with the launcher's CreateNew ownership marker. If it
 # already owns the volume, this refuses before detach. Keep this distinct
 # pre-fixture sentinel; it is not an isolation or termination receipt.
 Write-NewCompletionRecord (Join-Path $root 'reviewer-active.json') @{kind='pre-fixture-completion-detach';script_sha256=$scriptHash;fixture_started=$false}
 $providerError=$null;$readbackError=$null;$after=@()
 try{if((Get-ExactImage).Attached -eq $true){$null=Get-ExactDisk;Dismount-DiskImage -ImagePath $image -ErrorAction Stop|Out-Null}}catch{$providerError=$_.Exception.Message}
 try{$after=@(Get-ExactImage)}catch{$readbackError=$_.Exception.Message}
 $detached=$after.Count -eq 1 -and $after[0].Attached -eq $false
 $record=@{observed_at=[DateTime]::UtcNow.ToString('o');image=$image;detached_observed=$detached;provider_error=$providerError;readback_error=$readbackError;backing_file_retained=(Test-Path -LiteralPath $image);automatic_retry=$false;fixture_started=$false}
 Write-NewCompletionRecord (Join-Path $root 'completion-detach-result.json') $record
 $record|ConvertTo-Json
 if(-not $detached -or -not $record.backing_file_retained){throw 'detach unconfirmed; retain state and reconcile readback'}
 exit 0
}
foreach($name in @('storage.json','completion-intent.json','completion-result.json')){if(Test-Path -LiteralPath (Join-Path $root $name)){throw 'preparation already attempted; never repeat or overwrite'}}
$mountItem=Get-Item -LiteralPath $mount -Force
if(($mountItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or @(Get-ChildItem -LiteralPath $mount -Force).Count -ne 0){throw 'mount directory is not the retained empty plain directory'}
if((Get-ExactImage).Attached -ne $false){throw 'retained image must start detached'}
Write-NewCompletionRecord $intentPath @{observed_at=[DateTime]::UtcNow.ToString('o');image=$image;disk_unique_id=$diskId;owner_sid=$ownerSid;configuration_sha256=$configHash;script_sha256=$scriptHash;phase='detached-before-completion';fixture_started=$false}
$completed=$false;$providerError=$null;$readbackError=$null;$after=@();$stage='before-attach'
try{
 Mount-DiskImage -ImagePath $image -NoDriveLetter -ErrorAction Stop|Out-Null
 $stage='attached';$disk=Get-ExactDisk;$prepared=Get-PreparedPartition $disk $volumeId
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($identity.User);$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 Set-Acl -LiteralPath $prepared.Volume.Path -AclObject $acl
 $actualAcl=Get-Acl -LiteralPath $prepared.Volume.Path
 $rules=@($actualAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if($actualAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ownerSid -or -not $actualAcl.AreAccessRulesProtected -or $rules.Count -ne 2 -or @($rules.IdentityReference.Value|Sort-Object -Unique).Count -ne 2 -or @($rules|Where-Object { $_.IdentityReference.Value -notin @($ownerSid,'S-1-5-18') -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' -or $_.InheritanceFlags -ne 'ContainerInherit, ObjectInherit' -or $_.PropagationFlags -ne 'None' -or $_.IsInherited }).Count -ne 0){throw 'private volume ACL readback differs'}
 $stage='private-volume';$volume=Connect-PreparedPartition (Get-ExactDisk) $volumeId
 $stage='mounted';$null=Get-ExactDisk
 Write-NewCompletionRecord (Join-Path $root 'storage.json') @{schema_version=1;configuration_sha256=$configHash;image=$image;mount=$mount;disk_unique_id=$diskId;volume_guid=$volume.Path;maximum_bytes=536870912;observed_volume_bytes=$volume.Size;credentials='none';qualification='completed retained fixed storage only; no runtime/authentication acceptance'}
 $completed=$true;$stage='storage-receipt-written'
}catch{$providerError=$_.Exception.Message}
try{$after=@(Get-ExactImage)}catch{$readbackError=$_.Exception.Message}
$record=@{observed_at=[DateTime]::UtcNow.ToString('o');image=$image;stage=$stage;completed=$completed;provider_error=$providerError;readback_error=$readbackError;readback=@($after|Select-Object ImagePath,Attached,Size,DevicePath);created_image=$false;initialized=$false;formatted=$false;fixture_started=$false;automatic_retry=$false;backing_file_retained=(Test-Path -LiteralPath $image)}
Write-NewCompletionRecord $resultPath $record
$record|ConvertTo-Json -Depth 6
if(-not $completed -or $providerError -or $readbackError -or $after.Count -ne 1 -or $after[0].Attached -ne $true){throw 'completion not positively confirmed; retain state and use the approved matching recovery only'}
}finally{$operationLock.Dispose()}
