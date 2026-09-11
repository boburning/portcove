[CmdletBinding()]
param(
    [switch]$Help,
    [ValidateRange(1, 3600)]
    [int]$WaitSeconds = 900
)

if ($Help) {
    Write-Output "usage: run-windows-qualification.ps1 [-WaitSeconds SECONDS] [-Help]"
    Write-Output "Serializes the machine-global Windows qualification session and runs its integration suite."
    exit 0
}

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$mutexName = "Local\Portcove.WindowsQualification.v1"
$mutex = [System.Threading.Mutex]::new($false, $mutexName)
$ownsMutex = $false
$exitCode = 1

try {
    try {
        $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds))
    }
    catch [System.Threading.AbandonedMutexException] {
        # The operating system transferred ownership after a terminated holder.
        $ownsMutex = $true
    }

    if (-not $ownsMutex) {
        throw "Timed out after $WaitSeconds seconds waiting for the machine-global Windows qualification lock."
    }

    Push-Location $repositoryRoot
    try {
        & node --test scripts/windows-qualification-session.integration.test.mjs
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}

exit $exitCode
