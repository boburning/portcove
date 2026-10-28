# Shared read-only WebView/EdgeDriver policy. No install, cache or authority effects.
function Test-ReportedVersion([string]$Executable, [string[]]$Arguments, [string]$Version) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $reported = (& $Executable @Arguments 2>&1 | Out-String).Trim()
        return $LASTEXITCODE -eq 0 -and $reported -match "(?<![0-9])$([regex]::Escape($Version))(?![0-9])"
    }
    catch { return $false }
}


function Get-WebViewRuntimeVersion {
    $registryPaths = @(
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\Software\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\*"
    )
    $versions = @($registryPaths | ForEach-Object {
        Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue |
            Where-Object { $_.name -eq "Microsoft Edge WebView2 Runtime" } |
            ForEach-Object { [string]$_.pv }
    } | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object -Unique)
    if ($versions.Count -ne 1) {
        throw "Expected exactly one registered Evergreen WebView2 version; observed $($versions.Count)"
    }
    return $versions[0]
}

function Test-VerifiedEdgeDriver([string]$Executable, [string]$RuntimeVersion) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Executable
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
        throw "EdgeDriver does not have a valid Microsoft signature"
    }
    return Test-ReportedVersion $Executable @("--version") $RuntimeVersion
}

Export-ModuleMember -Function Test-ReportedVersion, Get-WebViewRuntimeVersion, Test-VerifiedEdgeDriver
