param(
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Provision','Detach','RecoverDetach')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$Configuration,
  [Parameter(Mandatory=$true)][string]$ExpectedConfigurationSha256,
  [string]$IsolationReceipt
)
# Operator-only inert qualification helper. Never launches a reviewer, reads
# authentication, activates an App, edits host quotas, or deletes a backing file.
$ErrorActionPreference='Stop'
if($ExpectedConfigurationSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Configuration -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedConfigurationSha256) { throw 'reviewed storage configuration changed' }
$config=Get-Content -Raw -LiteralPath $Configuration | ConvertFrom-Json
$workspace=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$allowed=[IO.Path]::GetFullPath((Join-Path $workspace 'work/slice4'))+[IO.Path]::DirectorySeparatorChar
$root=[IO.Path]::GetFullPath($config.root)
if($config.schema_version -ne 1 -or $config.maximum_bytes -ne 536870912 -or $config.credentials -ne 'none' -or -not $root.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($root) -notmatch '^semantic-storage-[a-f0-9]{32}$') { throw 'fixed inert storage scope differs' }
$image=Join-Path $root 'reviewer.vhd'
$mount=Join-Path $root 'data'
for($ancestor=[IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($root));$null -ne $ancestor;$ancestor=$ancestor.Parent) {
  if(($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'storage ancestry reparse refused' }
}
if($Operation -eq 'Inspect') {
  [ordered]@{operation='Inspect';configuration_sha256=$ExpectedConfigurationSha256;root=$root;image=$image;mount=$mount;maximum_bytes=536870912;credentials='none';mutations='none'} | ConvertTo-Json
  exit 0
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $identity.User.Value -ne $config.owner_sid) { throw 'same owner in an explicitly authorized elevated operator session required' }
function Get-OwnedDisk {
  $images=@(Get-DiskImage -ImagePath $image -ErrorAction Stop)
  if($images.Count -ne 1 -or -not $images[0].Attached) { throw 'owned image attachment unavailable or ambiguous' }
  $disks=@($images[0] | Get-Disk)
  if($disks.Count -ne 1 -or [string]::IsNullOrWhiteSpace($disks[0].UniqueId) -or $disks[0].Size -ne 536870912 -or $disks[0].IsBoot -ne $false -or $disks[0].IsSystem -ne $false -or [string]$disks[0].BusType -ne 'File Backed Virtual') { throw 'owned fixed disk identity unavailable; no numeric-disk fallback' }
  return $disks[0]
}
if($Operation -eq 'Provision') {
  if(Test-Path -LiteralPath $root) { throw 'storage root already exists; read back and recover, never repeat provisioning' }
  New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($identity.User);$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($identity.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
  Set-Acl -LiteralPath $root -AclObject $acl
  [IO.File]::WriteAllText((Join-Path $root '.portcove-semantic-storage-owned'),$ExpectedConfigurationSha256)
  $commands="create vdisk file=`"$image`" maximum=512 type=fixed`r`nselect vdisk file=`"$image`"`r`nattach vdisk`r`n"
  [IO.File]::WriteAllText((Join-Path $root 'diskpart.txt'),$commands)
  & diskpart.exe /s (Join-Path $root 'diskpart.txt') > (Join-Path $root 'diskpart.log') 2>&1
  if($LASTEXITCODE -ne 0) { throw 'virtual disk operation failed; retain partial state and inspect before recovery' }
  $disk=Get-OwnedDisk
  if([string]$disk.PartitionStyle -ne 'RAW') { throw 'new image is not a fresh RAW disk' }
  $unique=$disk.UniqueId
  [ordered]@{configuration_sha256=$ExpectedConfigurationSha256;image=$image;disk_unique_id=$unique;phase='attached-before-initialize'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'intent.json') -Encoding utf8NoBOM
  if((Get-OwnedDisk).UniqueId -ne $unique) { throw 'disk changed before initialize' }
  Initialize-Disk -UniqueId $unique -PartitionStyle GPT -ErrorAction Stop | Out-Null
  if((Get-OwnedDisk).UniqueId -ne $unique) { throw 'disk changed before partition' }
  $partitions=@(New-Partition -DiskId $unique -UseMaximumSize -ErrorAction Stop)
  if($partitions.Count -ne 1 -or (Get-OwnedDisk).UniqueId -ne $unique) { throw 'owned partition identity ambiguous' }
  $volume=Format-Volume -Partition $partitions[0] -FileSystem NTFS -NewFileSystemLabel 'PortcoveSemantic' -Confirm:$false -ErrorAction Stop
  if($volume.Size -gt 536870912 -or $volume.FileSystem -ne 'NTFS' -or (Get-OwnedDisk).UniqueId -ne $unique) { throw 'formatted volume outside fixed boundary' }
  New-Item -ItemType Directory -Path $mount -ErrorAction Stop | Out-Null
  Add-PartitionAccessPath -InputObject $partitions[0] -AccessPath ($mount+'\') -ErrorAction Stop
  # Only the broker/SYSTEM own the volume until a separately launched,
  # non-elevated fixture grants one disposable reviewer subdirectory.
  Set-Acl -LiteralPath $volume.Path -AclObject $acl
  [ordered]@{schema_version=1;configuration_sha256=$ExpectedConfigurationSha256;image=$image;mount=$mount;disk_unique_id=$unique;volume_guid=$volume.Path;maximum_bytes=536870912;observed_volume_bytes=$volume.Size;credentials='none';qualification='operator-provisioned fixed storage only; no runtime/authentication acceptance'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'storage.json') -Encoding utf8NoBOM
  Get-Content -Raw -LiteralPath (Join-Path $root 'storage.json')
} else {
  if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'owned root replaced' }
  if([IO.File]::ReadAllText((Join-Path $root '.portcove-semantic-storage-owned')) -ne $ExpectedConfigurationSha256) { throw 'owned storage marker differs' }
  $activePath=Join-Path $root 'reviewer-active.json'
  if($Operation -eq 'Detach' -and (Test-Path -LiteralPath $activePath)) { throw 'retained reviewer ownership; use reviewed RecoverDetach with matching positive teardown receipt' }
  if([string]::IsNullOrWhiteSpace($IsolationReceipt)) { throw 'retained positive empty-tree/profile-deletion readback required before detach' }
  $receiptPath=[IO.Path]::GetFullPath($IsolationReceipt)
  if(-not $receiptPath.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $receiptPath).Length -gt 16384) { throw 'isolation receipt outside scope' }
  $isolation=Get-Content -Raw -LiteralPath $receiptPath | ConvertFrom-Json
  $observed=Get-Content -Raw -LiteralPath (Join-Path $root 'storage.json') | ConvertFrom-Json
  if($observed.configuration_sha256 -ne $ExpectedConfigurationSha256 -or $observed.image -ne $image -or $observed.mount -ne $mount -or $isolation.profile_deleted -ne $true -or $isolation.process.TreeEmpty -ne $true -or $isolation.cleanup_errors.Count -ne 0 -or $isolation.bounded_mount -ne $mount -or $isolation.bounded_volume_guid -ne $observed.volume_guid -or (Get-OwnedDisk).UniqueId -ne $observed.disk_unique_id) { throw 'detach identity or teardown is unproven' }
  $activeLock=$null
  try {
  if($Operation -eq 'RecoverDetach') {
    if((Get-Item -LiteralPath $activePath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'active marker replaced' }
    $activeLock=[IO.File]::Open($activePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
    if($activeLock.Length -gt 4096) { throw 'active marker exceeds bound' }
    $reader=[IO.StreamReader]::new($activeLock,[Text.Encoding]::UTF8,$false,4096,$true)
    try { $active=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    $expectedRun=[IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($receiptPath))
    if($active.run_root -ne $expectedRun -or $active.profile_sid -ne $isolation.expected_sid -or $isolation.process.ObservedSid -ne $active.profile_sid) { throw 'active marker does not identify this terminated attempt' }
  } elseif($isolation.bounded_grants_removed -ne $true) { throw 'normal detach requires positive grant removal' }
  Dismount-DiskImage -ImagePath $image -ErrorAction Stop
  if((Get-DiskImage -ImagePath $image).Attached) { throw 'detach ambiguous; preserve image and retry only after readback' }
  [ordered]@{detached=$true;image=$image;backing_file_retained=$true;active_marker_retained=($Operation -eq 'RecoverDetach');isolation_receipt=$receiptPath;grants_removed=$isolation.bounded_grants_removed} | ConvertTo-Json
  } finally { if($null -ne $activeLock) { $activeLock.Dispose() } }
}
