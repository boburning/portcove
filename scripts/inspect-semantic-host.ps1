# Read-only operator observation. Does not activate features, mount disks, change
# quotas/ACLs, read credentials, start a reviewer, or alter the production hold.
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$features=@()
if($elevated) {
  $features=@(Get-WindowsOptionalFeature -Online | Where-Object { $_.FeatureName -match 'Hyper-V|Containers-DisposableClientVM|VirtualMachinePlatform' } | ForEach-Object {
    [ordered]@{name=$_.FeatureName;state=[string]$_.State}
  })
}
[ordered]@{
  schema_version=1
  qualification='read-only host capability observation; no runtime/storage enforcement or authority'
  observed_at=[DateTime]::UtcNow.ToString('o')
  elevated=$elevated
  os_version=[Environment]::OSVersion.VersionString
  virtual_disk_api_present=(Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32/virtdisk.dll'))
  sandbox_executable_present=(Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32/WindowsSandbox.exe'))
  hyperv_mount_cmdlet_present=([bool](Get-Command Mount-VHD -ErrorAction SilentlyContinue))
  features=$features
  fixed_volumes=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    [ordered]@{device=$_.DeviceID;filesystem=$_.FileSystem;size=$_.Size;free_bytes=$_.FreeSpace}
  })
  privilege_observation=(& whoami.exe /priv | Out-String)
} | ConvertTo-Json -Depth 5
if($LASTEXITCODE -ne 0) { throw 'privilege observation unavailable' }
