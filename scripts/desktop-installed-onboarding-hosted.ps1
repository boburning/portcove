$ErrorActionPreference = 'Stop'
$event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
if ($event.repository.full_name -cne 'boburning/portcove' -or $event.repository.private -ne $false) { throw 'The existing public repository is required.' }
# A fixed, secret-free observation on an existing disposable public runner.
# This is unrelated to protected release-controller eligibility or publication.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:ImageOS -cne 'win22' -or -not [Environment]::UserInteractive -or
    [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) { throw 'The existing disposable Windows 2022 interactive runner is required.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $source -cne $env:GITHUB_SHA -or $source -cnotmatch '^[0-9a-f]{40}$' -or
    (& git -C $root status --porcelain --untracked-files=normal)) { throw 'Exact clean checked-out source required.' }
$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
if (-not [IO.Directory]::Exists($temporaryRoot) -or $temporaryRoot.StartsWith('\\')) { throw 'Existing local runner temporary root required.' }
$sessionRoot = Join-Path $temporaryRoot ('portcove-installed-onboarding-' + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_RUN_ATTEMPT)
if (Test-Path -LiteralPath $sessionRoot) { throw 'Native evidence directory must be fresh.' }
[IO.Directory]::CreateDirectory($sessionRoot) | Out-Null
$packageRoot = Join-Path $sessionRoot 'ordinary-package'
$journeyRoot = Join-Path $sessionRoot 'installed-journey'
[IO.Directory]::CreateDirectory($journeyRoot) | Out-Null
$hostRecord = [ordered]@{
    source=$source; run=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; job=$env:GITHUB_JOB
    runner=$env:RUNNER_OS; image_os=$env:ImageOS; image_version=$env:ImageVersion
    os=[Runtime.InteropServices.RuntimeInformation]::OSDescription
    architecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    session_id=[Diagnostics.Process]::GetCurrentProcess().SessionId
    authority='None; ordinary unsigned package acceptance only, no protected publication'
}
$hostRecord | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sessionRoot 'host.json') -Encoding utf8
$exitCode=1
$failure=$null
try {
    & node (Join-Path $root 'scripts/desktop-test-cli.mts') --prepare-retained-package --output $packageRoot
    if ($LASTEXITCODE -ne 0) { throw 'Ordinary package preparation failed; preserve its original receipts.' }
    $build=Get-Content -LiteralPath (Join-Path $packageRoot 'build-result.json') -Raw | ConvertFrom-Json
    & node (Join-Path $root 'scripts/desktop-test-cli.mts') --current-installed `
        --installer $build.installer.path --package-evidence (Join-Path $packageRoot 'ordinary-package-manifest.json') `
        --expected-app $build.raw_executable.path --expected-version $build.version `
        --test-base (Join-Path $sessionRoot 'installer-runs') --evidence (Join-Path $journeyRoot 'installer-evidence.json') `
        --installed-scenario native-installed-onboarding-and-covers
    if ($LASTEXITCODE -ne 0) { throw 'Installed onboarding failed; preserve the failed package/session evidence.' }
    $exitCode=0
} catch { $failure=$_.Exception.Message }
finally {
    $binding=[ordered]@{source=$source;controller=$source;base=$source;run=$env:GITHUB_RUN_ID;attempt=$env:GITHUB_RUN_ATTEMPT;job=$env:GITHUB_JOB;phase='installed-onboarding';binding_sha256=''}
    $bindingBytes=[Text.UTF8Encoding]::new($false).GetBytes(($binding|ConvertTo-Json -Compress))
    $binding.binding_sha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bindingBytes)).ToLowerInvariant()
    $execution=[ordered]@{};foreach($key in $binding.Keys){$execution[$key]=$binding[$key]}
    $execution['exit_code']=$exitCode;$execution['failure']=$failure
    # Keep every bounded report/log/PNG in separate existing evidence envelopes.
    # Runtime databases, profiles, imported images and executable bytes stay local;
    # no artifact storage, cache, release, feed or signing mutation is performed.
    $files=@(Get-ChildItem -LiteralPath $sessionRoot -File | Where-Object Extension -In '.json','.log')
    if(Test-Path -LiteralPath $packageRoot){$files+=@(Get-ChildItem -LiteralPath $packageRoot -File|Where-Object Extension -In '.json','.log')}
    $files+=@(Get-ChildItem -LiteralPath $journeyRoot -File | Where-Object Extension -In '.json','.log')
    $boundary=Join-Path $journeyRoot 'current-installed-boundary'
    if(Test-Path -LiteralPath $boundary){
        $files+=@(Get-ChildItem -LiteralPath $boundary -File|Where-Object Extension -In '.json','.log')
        $native=Join-Path $boundary 'native'
        if(Test-Path -LiteralPath $native){$files+=@(Get-ChildItem -LiteralPath $native -File|Where-Object Extension -In '.json','.jsonl','.log','.png')}
    }
    $files=@($files|Sort-Object FullName -Unique)
    $inventory=@();foreach($file in $files){$inventory+=@{original=[IO.Path]::GetRelativePath($sessionRoot,$file.FullName);bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
    if([Text.Encoding]::UTF8.GetByteCount(($inventory|ConvertTo-Json -Depth 5)) -gt 512KB){throw 'Evidence inventory exceeds its envelope metadata budget.'}
    $index=0
    for($part=0;$index -lt $files.Count;$part++){
        $envelope=Join-Path $sessionRoot ('evidence-part-' + $part)
        [IO.Directory]::CreateDirectory($envelope)|Out-Null
        $binding|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $envelope 'binding.json') -Encoding utf8
        $execution|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $envelope 'execution.json') -Encoding utf8
        $inventory|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $envelope 'inventory.json') -Encoding utf8
        $partFiles=0;$partBytes=0L
        while($index -lt $files.Count -and $partFiles -lt 40){
            if($files[$index].Length -gt 4MB){throw 'One evidence file exceeds the bounded envelope input budget.'}
            if($partBytes+$files[$index].Length -gt 4MB){break}
            $name=('{0:D4}-' -f $index)+$files[$index].Name
            Copy-Item -LiteralPath $files[$index].FullName -Destination (Join-Path $envelope $name)
            $partBytes+=$files[$index].Length;$partFiles++;$index++
        }
        Write-Output ('PORTCOVE_INSTALLED_EVIDENCE_PART ' + $part)
        & node (Join-Path $root 'scripts/native-backup-evidence.mts') emit-hosted $envelope
        if($LASTEXITCODE -ne 0){throw 'Bounded installed evidence retention failed; do not infer a complete recovered receipt.'}
    }
}
if($failure){throw $failure}
exit $exitCode
