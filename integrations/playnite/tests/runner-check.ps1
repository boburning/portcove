param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference = 'Stop'

# Expected failures remain failures in their captured process result. This
# control never retries an action or passes a failed ordinary scenario.
function Invoke-RunnerControl([string]$RunnerExecutable, [string[]]$Arguments, [int]$ExpectedExit) {
    $lines = @(& $RunnerExecutable @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne $ExpectedExit) { throw "Runner control exit $exitCode, expected ${ExpectedExit}: $lines" }
    return $lines | ForEach-Object { "$_" }
}

$control = @(Invoke-RunnerControl $Executable @('--runner-control') 1)
$records = @($control | Where-Object { $_.StartsWith('SCENARIO ') } | ForEach-Object { $_.Substring(9) | ConvertFrom-Json })
if ($records.Count -ne 2 -or $records[0].id -ne 'control-failure' -or $records[0].status -ne 'failed' -or
    $records[0].failure.type -ne 'System.InvalidOperationException' -or
    $records[0].failure.message -ne 'Intentional runner control failure.' -or
    $records[1].id -ne 'control-after-failure' -or $records[1].status -ne 'passed' -or $records[1].checks -ne 1 -or
    !($control -contains 'FAIL 1 reference-client contract checks')) {
    throw "Runner did not preserve failure, continue once and aggregate failure: $control"
}
$expected = @('runtime-selection', 'personal-library', 'guided-setup', 'managed-removal', 'uninstall-controller',
    'installation-review', 'external-runtime-review', 'protocol', 'owned-transport', 'consumer-measurements',
    'long-session-observation', 'compiled-cli-consumer')
$listed = @(Invoke-RunnerControl $Executable @('--list-scenarios') 0)
if (($listed -join "`n") -cne ($expected -join "`n")) { throw "Unexpected scenario inventory: $listed" }
foreach ($invalid in @(
    @('--scenario', 'protocol', '--scenario', 'unknown'),
    @('--scenario', 'protocol', '--scenario', 'protocol'),
    @('--scenario'), @('unpaired-cli'), @('--list-scenarios', '--scenario', 'protocol')
)) {
    $refused = @(Invoke-RunnerControl $Executable $invalid 1)
    if (@($refused | Where-Object { $_.StartsWith('SCENARIO ') -or $_.StartsWith('PASS ') }).Count) {
        throw "Invalid selection executed scenarios before refusing: $refused"
    }
}
Write-Output 'PASS scenario runner failure continuation, aggregate exit and pre-execution selection controls'
