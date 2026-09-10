param()

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $projectRoot
try {
    $modulePath = (& node scripts/quality-tools.mjs --path psscriptanalyzer | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $modulePath) {
        throw "PSScriptAnalyzer is unavailable; run scripts/bootstrap-quality-tools.ps1"
    }
    Import-Module -Name $modulePath -Force
    $files = @(& git ls-files -- "*.ps1")
    if ($LASTEXITCODE -ne 0) { throw "could not enumerate tracked PowerShell files" }
    $findings = @($files | ForEach-Object {
        # These files are executable scripts with private helpers, not exported
        # modules. Cmdlet naming and ShouldProcess conventions do not apply.
        Invoke-ScriptAnalyzer -Path $_ -Severity Warning, Error -ExcludeRule PSUseApprovedVerbs, PSUseShouldProcessForStateChangingFunctions, PSUseSingularNouns
    })
    if ($findings.Count -gt 0) {
        $findings | Sort-Object ScriptPath, Line, Column | Format-Table -AutoSize | Out-String | Write-Error
    }
    Write-Output "PSScriptAnalyzer passed for $($files.Count) tracked PowerShell files."
}
finally {
    Pop-Location
}
