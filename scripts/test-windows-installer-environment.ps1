#!/usr/bin/env pwsh
# Inert regression: execute only the actual controlled-public environment-clear
# blocks in this child process. Never invoke the installer harness or an app.
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$source = Join-Path $PSScriptRoot 'test-windows-installer.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Installer harness did not parse' }
$branches = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -ceq '$ControlledPublicUpdate' -and
    $node.Clauses[0].Item2.Extent.Text.Contains("'PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_PAYLOAD'")
}, $true))
if ($branches.Count -ne 2) { throw 'Expected both actual controlled-public clear sites' }
$names = @('PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE', 'PORTCOVE_APPLICATION_UPDATE_METADATA_URL', 'PORTCOVE_APPLICATION_UPDATE_TARGETS_URL', 'PORTCOVE_APPLICATION_UPDATE_QUALIFICATION_PAYLOAD')
$evidence = [ordered]@{ controlled_public_transport = $null }
$observations = @()
foreach ($site in 0..1) {
    $branch = $branches[$site]
    $body = $branch.Clauses[0].Item2.Extent.Text
    $clear = [ScriptBlock]::Create($body.Substring(1, $body.Length - 2))
    foreach ($seed in @('', 'owned-disposable-probe')) {
        # The second site only needs to remove the payload left by prior local
        # refusal tests. Other transport overrides are already absent there.
        foreach ($name in $names) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
        $selected = if ($site -eq 0) { $names } else { @($names[-1]) }
        foreach ($name in $selected) { [Environment]::SetEnvironmentVariable($name, $seed, 'Process') }
        $evidence.controlled_public_transport = $null
        & $clear
        if ($site -eq 0 -and $evidence.controlled_public_transport -cne 'compiled HTTPS metadata and normal GitHub payload transport; no local repository or payload substitute') {
            throw 'Actual controlled-public transport receipt was not recorded'
        }
        foreach ($name in $names) {
            if ([Environment]::GetEnvironmentVariables('Process').Contains($name)) {
                throw "Controlled-public override remains present at line $($branch.Extent.StartLineNumber): $name"
            }
        }
        $observations += [ordered]@{ line = $branch.Extent.StartLineNumber; seed = $(if ($seed) { 'nonempty' } else { 'empty' }); overrides_absent = $true }
    }
}
[ordered]@{ scope = 'inert actual-call-site environment regression'; powershell = $PSVersionTable.PSVersion.ToString(); dotnet = [Environment]::Version.ToString(); observations = $observations; application_executed = $false } | ConvertTo-Json -Depth 5 -Compress
