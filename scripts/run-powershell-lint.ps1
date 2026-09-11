param()

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $projectRoot
try {
    $resources = Import-PowerShellDataFile -LiteralPath (Join-Path $projectRoot ".config\powershell-resources.psd1")
    $requiredVersion = [string]$resources.PSScriptAnalyzer.version
    if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer | Where-Object Version -EQ $requiredVersion)) {
        throw "PSScriptAnalyzer $requiredVersion is unavailable; run scripts/bootstrap-quality-tools.ps1"
    }
    Import-Module -Name PSScriptAnalyzer -RequiredVersion $requiredVersion -Force
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
