param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$Invocation
)

# Fixed inert capability fixture, never a package/host acceptance producer.
$ErrorActionPreference = 'Stop'
$registry = & (Join-Path $PSScriptRoot '../native-qualification-account-registry.ps1') -Invocation $Invocation | ConvertFrom-Json
if ($registry.pid -ne $PID -or
    $registry.account_sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
    -not [string]::Equals($registry.profile,
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile),
        [StringComparison]::OrdinalIgnoreCase) -or
    $registry.hive_present -ne $true -or
    $registry.provenance -cne 'target-account-HKCU' -or
    $registry.authority -cne 'none') { throw 'Actual own-account registry observation differs' }
Add-Type -AssemblyName System.Windows.Forms
$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 60') `
    -PassThru -WindowStyle Hidden
$form = [Windows.Forms.Form]::new()
$timer = [Windows.Forms.Timer]::new()
try {
    $form.Text = "Portcove inert account $($Invocation.Substring(0, 12))"
    $form.Width = 400
    $form.Height = 150
    $timer.Interval = 15000
    $timer.Add_Tick({ $form.Close() })
    $timer.Start()
    [ordered]@{
        schema_version = 1
        invocation = $Invocation
        fixture = 'inert-account-gui-profile-and-descendants'
        pid = $PID
        account_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        child_pid = $child.Id
        registry = $registry
        authority = 'none'
    } | ConvertTo-Json -Depth 8 -Compress | Write-Output
    $form.ShowDialog() | Out-Null
} finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    # The fixed owner parent must terminate/read back the JobObject, including
    # this deliberately surviving inert child. Fixture stdout cannot assert it.
    $child.Dispose()
}
