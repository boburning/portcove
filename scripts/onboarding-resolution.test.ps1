$ErrorActionPreference = 'Stop'
# Load only the production functions under test; never execute the hosted guard
# or journey on a developer account.
$scriptPath = Join-Path $PSScriptRoot 'onboarding-native.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Controller parse failure.' }
foreach ($name in @('Require','Resolve-Application','Start-Owned','Complete-Owned','Append-Json')) {
    $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($functions.Count -ne 1) { throw "Expected one production $name function." }
    Invoke-Expression $functions[0].Extent.Text
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('onboarding-resolution-' + [guid]::NewGuid())
$first = Join-Path $testRoot 'first path'; $second = Join-Path $testRoot 'second path'
[void][IO.Directory]::CreateDirectory($first); [void][IO.Directory]::CreateDirectory($second)
$commandRoot = Join-Path $testRoot 'commands'; [void][IO.Directory]::CreateDirectory($commandRoot)
$EvidenceRoot = $testRoot; $utf8 = [Text.UTF8Encoding]::new($false)
$script:ownedCommands = [Collections.Generic.List[object]]::new()
$originalPath = $env:PATH
$pwshPath = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$probeName = 'onboarding-application-probe.exe'
$firstExe = Join-Path $first $probeName; $secondExe = Join-Path $second $probeName
[IO.File]::Copy((Join-Path $env:SystemRoot 'System32/where.exe'), $firstExe)
[IO.File]::Copy((Join-Path $env:SystemRoot 'System32/where.exe'), $secondExe)
function Refuses([scriptblock]$Action) {
    $refused = $false
    try { & $Action | Out-Null } catch { $refused = $true }
    Require $refused 'An invalid executable was accepted.'
}
try {
    $env:PATH = "$first;$second;$originalPath"
    Require (@(Get-Command $probeName -CommandType Application).Count -eq 2) 'Regression fixture did not establish two application matches.'
    $old = [Diagnostics.ProcessStartInfo]::new()
    $old.FileName = (Get-Command $probeName -CommandType Application).Source
    Require ($old.FileName -eq "$firstExe $secondExe") 'Original multiple-match coercion was not reproduced.'
    Require ((Resolve-Application $probeName) -ceq $firstExe) 'First PATH application was not selected.'
    $env:PATH = "$second;$first;$originalPath"
    Require ((Resolve-Application $probeName) -ceq $secondExe) 'Changed PATH precedence was ignored.'
    Require ((Resolve-Application $firstExe) -ceq $firstExe) 'Explicit absolute executable changed.'
    Refuses { Resolve-Application (Join-Path $first 'missing.exe') }
    Refuses { Resolve-Application $first }
    Refuses { Resolve-Application 'onboarding-application-does-not-exist' }
    Set-Alias -Name onboarding-application-probe.exe -Value Get-Date
    Require ((Resolve-Application $probeName) -ceq $secondExe) 'A PowerShell alias replaced application resolution.'
    $literal = @('two words', 'quote"inside', '$(throw bad)', '; echo bad', '')
    $literalJson = ConvertTo-Json -InputObject $literal -Compress
    $childCode = '$expected=' + "'" + $literalJson.Replace("'", "''") + "'" + '; $actual=ConvertTo-Json -InputObject @($args) -Compress; if ($actual -cne $expected) { throw "Arguments changed: $actual" }; Write-Output "literal-arguments-ok"'
    $childScript = Join-Path $testRoot 'literal-child.ps1'
    [IO.File]::WriteAllText($childScript, $childCode, $utf8)
    $owned = Start-Owned $pwshPath (@('-NoLogo','-NoProfile','-File', $childScript) + $literal) $testRoot 'literal-arguments'
    try {
        $result = Complete-Owned $owned 15
        Require ($result.exit_code -eq 0 -and $result.stdout.Trim() -eq 'literal-arguments-ok') "Literal argument child failed: $($result.stderr)"
    } finally { if ($owned.completed) { $owned.process.Dispose() } }
    $source = [IO.File]::ReadAllText($scriptPath)
    Require ($source.Contains('$buildNode = Resolve-Application ''node''')) 'Build caller bypasses scalar resolution.'
    [pscustomobject]@{ result='passed'; multiple_matches=2; checks=9; evidence=$testRoot } | ConvertTo-Json
} finally {
    $env:PATH = $originalPath
    Remove-Item -LiteralPath 'Alias:onboarding-application-probe.exe' -ErrorAction SilentlyContinue
    # Keep the small regression fixture and command receipts for inspection.
}
