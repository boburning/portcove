param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$Invocation
)

# Fixed inert capability fixture, never a package/host acceptance producer.
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('inert-probe:started')
$registry = & (Join-Path $PSScriptRoot '../native-qualification-account-registry.ps1') -Invocation $Invocation -DiagnosticStages | ConvertFrom-Json
if ($registry.pid -ne $PID -or
    $registry.account_sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
    -not [string]::Equals($registry.profile,
        [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile),
        [StringComparison]::OrdinalIgnoreCase) -or
    $registry.hive_present -ne $true -or
    $registry.provenance -cne 'target-account-HKCU' -or
    $registry.authority -cne 'none') { throw 'Actual own-account registry observation differs' }
[Console]::Error.WriteLine('inert-probe:registry-read')
Add-Type -AssemblyName System.Windows.Forms
[Console]::Error.WriteLine('inert-probe:forms-loaded')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InertProbeWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
}
'@
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
    $observation = [ordered]@{
        schema_version = 1
        invocation = $Invocation
        fixture = 'inert-account-gui-profile-and-descendants'
        pid = $PID
        account_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        child_pid = $child.Id
        registry = $registry
        authority = 'none'
    }
    [Console]::Out.WriteLine(($observation | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Error.WriteLine('inert-probe:message-loop')
    # The isolated window station is non-interactive; a modal dialog refuses it.
    # Consume native startup show state explicitly before showing this own private form.
    $form.Show()
    [void][InertProbeWindow]::ShowWindow($form.Handle, 0)
    [void][InertProbeWindow]::ShowWindow($form.Handle, 5)
    $parent = [InertProbeWindow]::GetAncestor($form.Handle, 1)
    $desktop = [InertProbeWindow]::GetDesktopWindow()
    [Console]::Error.WriteLine(('inert-probe:window-state own={0}:{1:X8};parent={2}:{3:X8};desktop={4}:{5:X8}' -f
        $form.Handle.ToInt64(), [InertProbeWindow]::GetWindowLongW($form.Handle, -16),
        $parent.ToInt64(), [InertProbeWindow]::GetWindowLongW($parent, -16),
        $desktop.ToInt64(), [InertProbeWindow]::GetWindowLongW($desktop, -16)))
    if (-not [InertProbeWindow]::IsWindowVisible($form.Handle)) { throw 'Inert own form remains hidden' }
    [Console]::Error.WriteLine('inert-probe:own-window-visible')
    [Windows.Forms.Application]::Run($form)
} finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    # The fixed owner parent must terminate/read back the JobObject, including
    # this deliberately surviving inert child. Fixture stdout cannot assert it.
    $child.Dispose()
}
