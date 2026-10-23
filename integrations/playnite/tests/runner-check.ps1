param([Parameter(Mandatory)][string]$Executable)
$ErrorActionPreference = 'Stop'

# Expected failures remain failures in their captured process result. This
# control never retries an action or passes a failed ordinary scenario.
function Invoke-RunnerControl([string]$Program, [string[]]$Arguments, [int]$ExpectedExit) {
    $PSNativeCommandUseErrorActionPreference = $false
    $lines = @(& $Program @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne $ExpectedExit) { throw "Runner control exit $exitCode, expected ${ExpectedExit}: $lines" }
    return $lines | ForEach-Object { "$_" }
}

function Assert-ScenarioIdentity([object[]]$Records, [string]$Program) {
    $digest = (Get-FileHash -LiteralPath $Program -Algorithm SHA256).Hash.ToLowerInvariant()
    $invocations = @($Records | Select-Object -ExpandProperty invocation_id -Unique)
    if (!$Records.Count -or $invocations.Count -ne 1 -or $invocations[0] -cnotmatch '^[a-f0-9]{32}$') {
        throw 'Scenario results must join exactly one bounded invocation identity.'
    }
    foreach ($record in $Records) {
        if ($record.runner -cne 'Portcove.ContractTests' -or
            $record.source.kind -cne 'compiled-contract-assembly' -or $record.source.sha256 -cne $digest -or
            $record.platform -cne [Environment]::OSVersion.Platform.ToString() -or
            $record.process_bits -notin @(32, 64) -or
            $record.runtime_version -cnotmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$') {
            throw 'Scenario result differs from its actual compiled runner or execution platform.'
        }
    }
}

$control = @(Invoke-RunnerControl $Executable @('--runner-control') 1)
$records = @($control | Where-Object { $_.StartsWith('SCENARIO ') } | ForEach-Object { $_.Substring(9) | ConvertFrom-Json })
Assert-ScenarioIdentity $records $Executable
if ($records.Count -ne 2 -or $records[0].id -ne 'control-failure' -or $records[0].status -ne 'failed' -or
    $records[0].failure.type -ne 'System.InvalidOperationException' -or
    $records[0].failure.message -ne 'Intentional runner control failure.' -or
    $records[1].id -ne 'control-after-failure' -or $records[1].status -ne 'passed' -or $records[1].checks -ne 1 -or
    !($control -contains 'FAIL 1 reference-client contract checks')) {
    throw "Runner did not preserve failure, continue once and aggregate failure: $control"
}
foreach ($line in $control) { Write-Output "RUNNER_CONTROL_OUTPUT $line" }
$reporting = @(Invoke-RunnerControl $Executable @('--runner-reporting-control') 1)
$reported = @($reporting | Where-Object { $_.StartsWith('SCENARIO ') } | ForEach-Object { $_.Substring(9) | ConvertFrom-Json })
Assert-ScenarioIdentity $reported $Executable
if ($reported[0].invocation_id -ceq $records[0].invocation_id) { throw 'Independent runner processes reused an invocation identity.' }
if ($reported.Count -ne 1 -or $reported[0].id -ne 'control-after-failure' -or $reported[0].status -ne 'passed' -or
    !($reporting -match 'Intentional runner control failure\.') -or
    !($reporting -match 'Intentional scenario reporting failure\.') -or
    !($reporting -contains 'FAIL 1 reference-client contract checks')) {
    throw "Reporting failure masked the original outcome or stopped independent reporting: $reporting"
}
foreach ($line in $reporting) { Write-Output "RUNNER_REPORTING_CONTROL_OUTPUT $line" }
$skipped = @(Invoke-RunnerControl $Executable @('--scenario', 'compiled-cli-consumer') 1)
$skipRecords = @($skipped | Where-Object { $_.StartsWith('SCENARIO ') } | ForEach-Object { $_.Substring(9) | ConvertFrom-Json })
Assert-ScenarioIdentity $skipRecords $Executable
if ($skipRecords.Count -ne 1 -or $skipRecords[0].id -ne 'compiled-cli-consumer' -or
    $skipRecords[0].status -ne 'skipped' -or $skipRecords[0].checks -ne 0 -or
    !$skipRecords[0].skip_reason -or !($skipped -contains 'FAIL 0 reference-client contract checks')) {
    throw "Skipped-only selection fabricated a pass or lost its reason: $skipped"
}
foreach ($line in $skipped) { Write-Output "RUNNER_SKIP_CONTROL_OUTPUT $line" }
foreach ($field in @('invocation', 'source', 'platform', 'runner', 'runtime', 'architecture')) {
    $changed = @($records | ConvertTo-Json -Depth 8 | ConvertFrom-Json)
    switch ($field) {
        'invocation' { $changed[1].invocation_id = 'f' * 32 }
        'source' { $changed[0].source.sha256 = '0' * 64 }
        'platform' { $changed[0].platform = 'unobserved-platform' }
        'runner' { $changed[0].runner = 'another-runner' }
        'runtime' { $changed[0].runtime_version = 'unknown' }
        'architecture' { $changed[0].process_bits = 0 }
    }
    $refused = $false
    try { Assert-ScenarioIdentity $changed $Executable } catch { $refused = $true }
    if (!$refused) { throw "Runner identity control accepted changed $field metadata." }
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
# Exercise actual qualification dispatch with the existing synthetic producer.
# These controls are not real Rust producer or Playnite lifecycle qualification.
$library = Join-Path (Split-Path $Executable) 'fixture-library'
foreach ($item in @(
    @{arguments = @('qualification-measurement', $Executable, $library, 'shape-a', 'owned-fixture'); exit = 0; checks = 3; failure = $null},
    @{arguments = @('qualification-measurement', $Executable, $library, 'shape-a', 'wrong-library'); exit = 1; checks = 0; failure = 'library identity is stable across compiled-client reconnects'},
    @{arguments = @('qualification-source-guidance'); exit = 1; checks = 0; failure = 'Qualification mode requires a CLI, library, and fixture port.'}
)) {
    $phase = @(Invoke-RunnerControl $Executable $item.arguments $item.exit)
    $phaseRecords = @($phase | Where-Object { $_.StartsWith('SCENARIO ') } | ForEach-Object { $_.Substring(9) | ConvertFrom-Json })
    Assert-ScenarioIdentity $phaseRecords $Executable
    if ($phaseRecords.Count -ne 1 -or $phaseRecords[0].id -cne $item.arguments[0] -or
        $phaseRecords[0].checks -ne $item.checks -or
        $phaseRecords[0].status -cne $(if ($item.exit -eq 0) { 'passed' } else { 'failed' }) -or
        $phaseRecords[0].failure.message -cne $item.failure) {
        throw "Qualification dispatch lost its original outcome or joined record: $phase"
    }
    foreach ($line in $phase) { Write-Output "RUNNER_QUALIFICATION_CONTROL_OUTPUT $line" }
}
Write-Output 'PASS scenario runner failure continuation, aggregate exit, selection and joined identity controls'
