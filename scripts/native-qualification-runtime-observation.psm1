# Read-only observation shared by the two fixed controller paths; no execution authority.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Read-PortcoveNativeRuntimeObservation {
    param([Parameter(Mandatory)][string]$CaptureRoot,[Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$BindingSha256)
    $runtimePath=Join-Path $CaptureRoot 'isolated-account-desktop\native-runtime-capabilities.json'
    if((Get-Item -LiteralPath $runtimePath).Length -gt 131072){throw 'Native runtime observation exceeds its bound'}
    $runtime=Get-Content -LiteralPath $runtimePath -Raw|ConvertFrom-Json
    if($runtime.schema_version -ne 1 -or $runtime.authority -cne 'none' -or
        $runtime.account_binding_sha256 -cne $BindingSha256 -or @($runtime.loaded_engine_images).Count -lt 1 -or
        @($runtime.loaded_engine_images).Count -gt 4){throw 'Native runtime observation differs from the fixed account invocation'}
    $engines=@($runtime.loaded_engine_images|ForEach-Object{
        $item=Get-Item -LiteralPath $_.path -Force
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -gt 268435456 -or $item.Length -ne $_.bytes -or $item.Name -ine 'msedgewebview2.exe' -or
            (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $_.sha256){throw 'Actual loaded WebView image changed'}
        $version=([Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName).FileVersion -split ' ')[0]
        if($version -cnotmatch '^[0-9]+(?:[.][0-9]+){1,3}$' -or
            (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $_.sha256){throw 'Actual loaded WebView image/version is unavailable or changed'}
        [ordered]@{path=$item.FullName;bytes=$item.Length;sha256=$_.sha256;version=$version}
    })
    $machine=[string](Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid)
    if($machine -cnotmatch '^[a-fA-F0-9-]{32,36}$'){throw 'Native machine identity is unavailable'}
    $machineBytes=[Text.UTF8Encoding]::new($false).GetBytes($machine.ToLowerInvariant())
    $machineSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($machineBytes)).ToLowerInvariant()
    [ordered]@{machine_id_sha256=$machineSha;os_version=[Environment]::OSVersion.Version.ToString();
        architecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString();
        runtime_sha256=(Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant();engine_images=$engines}
}

Export-ModuleMember -Function Read-PortcoveNativeRuntimeObservation
