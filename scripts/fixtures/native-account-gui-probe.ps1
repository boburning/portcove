param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$Invocation
)

# Fixed inert capability fixture, never a package/host acceptance producer.
$ErrorActionPreference = 'Stop'
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
        authority = 'none'
    } | ConvertTo-Json -Compress | Write-Output
    $form.ShowDialog() | Out-Null
} finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    # The fixed owner parent must terminate/read back the JobObject, including
    # this deliberately surviving inert child. Fixture stdout cannot assert it.
    $child.Dispose()
}
