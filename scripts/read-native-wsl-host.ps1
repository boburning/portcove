[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrokerSid,
    [Parameter(Mandatory)][Guid]$RegistrationId,
    [Parameter(Mandatory)][string]$DistributionName,
    [Parameter(Mandatory)][UInt32]$ParentProcessId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($BrokerSid -notmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$' -or
    $DistributionName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $ParentProcessId -lt 1) {
    throw 'Fixed WSL host observation inputs differ'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($identity.User.Value -ne $BrokerSid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Actual ordinary WSL broker identity differs'
}
$reader = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$PID"
if ($null -eq $reader -or [UInt32]$reader.ParentProcessId -ne $ParentProcessId) {
    throw 'WSL observation is not the fixed parent child'
}
$key = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Lxss\{' + $RegistrationId.ToString('D') + '}'
function Read-FixedRegistration {
    $value = Get-ItemProperty -LiteralPath $key
    if ($value.DistributionName -cne $DistributionName -or [UInt32]$value.Version -ne 2) {
        throw 'Actual appointed WSL registration differs'
    }
    [ordered]@{
        registration_id = $RegistrationId.ToString('D').ToLowerInvariant()
        name = [string]$value.DistributionName
        wsl_version = [UInt32]$value.Version
        default_uid = [UInt32]$value.DefaultUid
    }
}
$before = Read-FixedRegistration
$after = Read-FixedRegistration
if (($before | ConvertTo-Json -Compress) -cne ($after | ConvertTo-Json -Compress)) {
    throw 'WSL registration changed during observation'
}
[ordered]@{
    schema_version = 1
    broker_sid = $identity.User.Value
    reader_pid = $PID
    parent_pid = $ParentProcessId
    observed_at = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    before = $before
    after = $after
    mutations = 'none'
} | ConvertTo-Json -Depth 5 -Compress
