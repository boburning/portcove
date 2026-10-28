param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$Invocation,
    [switch]$DiagnosticStages
)

# Fixed trusted observation under the already authenticated target token. No
# caller-selected registry roots, values, SID, profile, or write operations.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:identity-begin') }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:identity-read') }
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    @($identity.Groups | Where-Object Value -EQ 'S-1-5-32-544').Count) { throw 'Registry reader requires a non-administrator target token' }
if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:principal-checked') }
$sid = $identity.User.Value
$targetProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if (-not [IO.Path]::IsPathRooted($targetProfile) -or $targetProfile -cnotmatch '^[A-Za-z]:\\') { throw 'Actual target profile unavailable' }
if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:profile-read') }
$hive = [Microsoft.Win32.Registry]::Users.OpenSubKey($sid, $false)
if ($null -eq $hive) { throw 'Actual target loaded hive unavailable' }
$hive.Dispose()
if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:hive-read') }

function Read-FixedUserRegistry {
    param([Parameter(Mandatory)][string]$Subkey, [Parameter(Mandatory)][string[]]$Properties)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Subkey, $false)
    if ($null -eq $key) { return }
    try {
        $names = @($key.GetSubKeyNames())
        if ($names.Count -gt 128) { throw 'Fixed registry enumeration exceeds bound' }
        foreach ($name in $names) {
            if ($name.Length -gt 256 -or $name.Contains('\')) { throw 'Registry subkey name exceeds bound' }
            $child = $key.OpenSubKey($name, $false)
            if ($null -eq $child) { throw 'Registry subkey changed during observation' }
            try {
                $record = [ordered]@{ PSPath = 'Microsoft.PowerShell.Core\Registry::HKEY_CURRENT_USER\' + $Subkey + '\' + $name; account_sid = $sid }
                foreach ($property in $Properties) {
                    $value = $child.GetValue($property, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                    if ($value -isnot [string] -or $value.Length -gt 4096) { throw 'Fixed registry value has unsupported type or length' }
                    $record[$property] = $value
                }
                [pscustomobject]$record
            } finally { $child.Dispose() }
        }
    } finally { $key.Dispose() }
}

if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:fixed-values-begin') }
$result = [ordered]@{
    schema_version = 1; invocation = $Invocation; pid = $PID
    account_sid = $sid; profile = $targetProfile; hive_present = $true
    provenance = 'target-account-HKCU'; authority = 'none'
    uninstall = @(Read-FixedUserRegistry 'Software\Microsoft\Windows\CurrentVersion\Uninstall' @('DisplayName','DisplayVersion','InstallLocation','UninstallString','QuietUninstallString'))
    webview = @(Read-FixedUserRegistry 'Software\Microsoft\EdgeUpdate\Clients' @('name','pv'))
}
if ($DiagnosticStages) { [Console]::Error.WriteLine('inert-registry:fixed-values-read') }
$json = $result | ConvertTo-Json -Depth 5 -Compress
if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'Fixed registry report exceeds bound' }
$json | Write-Output
