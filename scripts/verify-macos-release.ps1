param(
    [Parameter(Mandatory = $true)][string]$DmgPath,
    [Parameter(Mandatory = $true)][string]$Version,
    [ValidateSet("x86_64", "arm64")][string]$Architecture = "x86_64"
)

$ErrorActionPreference = "Stop"
$dmg = (Resolve-Path -LiteralPath $DmgPath).Path
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "portcove-macos-release-$([System.Guid]::NewGuid().ToString('N'))"
$mountedVolume = $null
$launchedProcess = $null
[System.IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    $output = & $Command @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE`n$($output -join "`n")"
    }
    return $output
}

function Invoke-CheckedWithResponse([string]$Command, [string[]]$Arguments, [string]$Response) {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Command
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Environment["PAGER"] = "/bin/cat"
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine($Response)
    $process.StandardInput.Close()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
        throw "$Command failed with exit code $($process.ExitCode)`n$stderr`n$stdout"
    }
    return $stdout
}

try {
    $attach = Invoke-CheckedWithResponse "hdiutil" @("attach", "-readonly", "-nobrowse", "-plist", $dmg) "Y"
    $plistStart = $attach.IndexOf("<?xml")
    if ($plistStart -lt 0) {
        throw "hdiutil attach did not return an XML property list`n$attach"
    }
    $attachPlist = $attach.Substring($plistStart)
    $attachPath = Join-Path $temporaryRoot "attach.plist"
    [System.IO.File]::WriteAllText($attachPath, $attachPlist)
    $attachJson = Invoke-Checked "plutil" @("-convert", "json", "-o", "-", $attachPath)
    $attachData = ($attachJson -join "`n") | ConvertFrom-Json
    $mountedVolume = @($attachData.'system-entities' | Where-Object { $_.'mount-point' })[-1].'mount-point'
    if ([string]::IsNullOrWhiteSpace($mountedVolume)) { throw "DMG did not expose a mounted volume" }

    $apps = @(Get-ChildItem -LiteralPath $mountedVolume -Filter "*.app" -Directory)
    if ($apps.Count -ne 1) { throw "DMG must contain exactly one application bundle" }
    $appCopy = Join-Path $temporaryRoot $apps[0].Name
    Copy-Item -LiteralPath $apps[0].FullName -Destination $appCopy -Recurse
    $plist = Join-Path $appCopy "Contents/Info.plist"
    $identifier = (Invoke-Checked "plutil" @("-extract", "CFBundleIdentifier", "raw", $plist) | Out-String).Trim()
    $bundleVersion = (Invoke-Checked "plutil" @("-extract", "CFBundleShortVersionString", "raw", $plist) | Out-String).Trim()
    $executableName = (Invoke-Checked "plutil" @("-extract", "CFBundleExecutable", "raw", $plist) | Out-String).Trim()
    if ($identifier -ne "io.github.portcove.portcove") { throw "Unexpected bundle identifier: $identifier" }
    if ($bundleVersion -ne $Version) { throw "Expected bundle version $Version, received $bundleVersion" }

    $executable = Join-Path $appCopy "Contents/MacOS/$executableName"
    $file = (Invoke-Checked "file" @($executable) | Out-String)
    if ($file -notmatch [regex]::Escape($Architecture)) {
        throw "Application executable does not contain the expected $Architecture architecture: $file"
    }
    $linked = Invoke-Checked "otool" @("-L", $executable)
    foreach ($line in @($linked | Select-Object -Skip 1)) {
        $dependency = ($line.Trim() -split " ")[0]
        if ($dependency -and $dependency -notmatch '^(/System/Library/|/usr/lib/|@rpath/|@executable_path/|@loader_path/)') {
            throw "Unexpected non-system dylib dependency: $dependency"
        }
    }
    $loadCommands = (Invoke-Checked "otool" @("-l", $executable) | Out-String)
    if ($loadCommands -notmatch 'LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX') {
        throw "Application executable does not declare a macOS deployment target"
    }

    $env:PORTCOVE_LIBRARY = Join-Path $temporaryRoot "library"
    $env:PORTCOVE_PREFERENCES = Join-Path $temporaryRoot "preferences.json"
    [System.IO.Directory]::CreateDirectory($env:PORTCOVE_LIBRARY) | Out-Null
    $launchedProcess = Start-Process -FilePath "/usr/bin/open" -ArgumentList @("-W", "-n", $appCopy) -PassThru
    Start-Sleep -Seconds 5
    if ($launchedProcess.HasExited) { throw "Packaged application exited during native startup" }
    Invoke-Checked "osascript" @("-e", "tell application id `"$identifier`" to quit") | Out-Null
    if (-not $launchedProcess.WaitForExit(20000)) {
        throw "Packaged application did not close cleanly after a quit request"
    }
    if ($launchedProcess.ExitCode -ne 0) { throw "Packaged application exited with code $($launchedProcess.ExitCode)" }
    $launchedProcess = $null
    Write-Output "Verified $Architecture DMG identity, linkage, deployment target, native launch, and clean close."
}
finally {
    if ($launchedProcess -and -not $launchedProcess.HasExited) {
        Stop-Process -Id $launchedProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($mountedVolume) {
        & hdiutil detach $mountedVolume -quiet 2>$null
    }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
