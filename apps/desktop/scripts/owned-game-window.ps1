param(
    [Parameter(Mandatory)][string]$SnapshotPath,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ApplicationSha256,
    [Parameter(Mandatory)][string]$ScreenshotPath,
    [Parameter(Mandatory)][string]$ObservationPath,
    [Parameter(Mandatory)][ValidateRange(1,30)][int]$ReadySeconds
)
$ErrorActionPreference = 'Stop'
$snapshot = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
$applicationFull = (Resolve-Path -LiteralPath $ApplicationPath).Path
$records = @($snapshot.processes | Where-Object pid -eq $snapshot.application_pid)
if ($records.Count -ne 1 -or $snapshot.application_pid -eq $snapshot.driver.pid) { throw 'One separately owned game process is required.' }
$record = $records[0]
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if (-not [Environment]::UserInteractive -or $session -le 0) { throw 'An existing interactive Windows session is required; no alternate session will be created.' }
foreach ($path in @($ScreenshotPath,$ObservationPath)) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or (Test-Path -LiteralPath $path) -or -not (Test-Path -LiteralPath (Split-Path $path) -PathType Container)) { throw 'Window evidence requires fresh files in the owned evidence directory.' }
}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PortcoveOwnedGameWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
}
'@
# Capture in physical pixels. Failure leaves the run inconclusive instead of guessing scale.
if ([PortcoveOwnedGameWindow]::GetAwarenessFromDpiAwarenessContext([PortcoveOwnedGameWindow]::GetThreadDpiAwarenessContext()) -ne 2) {
    [void][PortcoveOwnedGameWindow]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
}
if ([PortcoveOwnedGameWindow]::GetAwarenessFromDpiAwarenessContext([PortcoveOwnedGameWindow]::GetThreadDpiAwarenessContext()) -ne 2) { throw 'Could not establish physical-pixel coordinates for this capture helper.' }
function Assert-Process($Identity) {
    $process = [Diagnostics.Process]::GetProcessById([int]$Identity.pid)
    try {
        if ($process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $Identity.started_filetime -or
            -not [string]::Equals($process.MainModule.FileName, $Identity.path, [StringComparison]::OrdinalIgnoreCase) -or
            $process.SessionId -ne $session) { throw 'Captured process path, incarnation or interactive session changed.' }
        [pscustomobject]@{ pid=$process.Id; started_filetime=$Identity.started_filetime; path=$process.MainModule.FileName; session_id=$process.SessionId; handle=$process.MainWindowHandle; title=$process.MainWindowTitle }
    } finally { $process.Dispose() }
}
function Assert-Game {
    $driver = Assert-Process $snapshot.driver
    $game = Assert-Process $record
    if (-not [string]::Equals($game.path, $applicationFull, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -LiteralPath $applicationFull -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ApplicationSha256) { throw 'Reviewed game executable changed.' }
    foreach ($child in @($snapshot.processes)) { [void](Assert-Process $child) }
    $game
}
$deadline = [DateTime]::UtcNow.AddSeconds($ReadySeconds)
do {
    $game = Assert-Game
    if ($game.handle -ne [IntPtr]::Zero -and [PortcoveOwnedGameWindow]::IsWindowVisible($game.handle) -and -not [PortcoveOwnedGameWindow]::IsIconic($game.handle)) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($game.handle -eq [IntPtr]::Zero -or -not [PortcoveOwnedGameWindow]::IsWindowVisible($game.handle) -or [PortcoveOwnedGameWindow]::IsIconic($game.handle)) { throw 'The exact owned game did not expose a visible main window within the fixed bound.' }
$window = $game.handle
[uint32]$windowOwner = 0
[void][PortcoveOwnedGameWindow]::GetWindowThreadProcessId($window, [ref]$windowOwner)
if ($windowOwner -ne $record.pid) { throw 'Main window belongs to a different process.' }
$focusRequested = $false
if ([PortcoveOwnedGameWindow]::GetForegroundWindow() -ne $window) {
    # One normal focus request. No synthetic keyboard, foreground-lock bypass or retry.
    $focusRequested = $true
    $focusAccepted = [PortcoveOwnedGameWindow]::SetForegroundWindow($window)
    $focusDeadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        if ([PortcoveOwnedGameWindow]::GetForegroundWindow() -eq $window) { break }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $focusDeadline)
    if (-not $focusAccepted -or [PortcoveOwnedGameWindow]::GetForegroundWindow() -ne $window) { throw 'The owned game did not become foreground; preserve the host contention/feasibility failure.' }
}
$bounds = [PortcoveOwnedGameWindow+RECT]::new()
if (-not [PortcoveOwnedGameWindow]::GetWindowRect($window, [ref]$bounds)) { throw 'Owned window bounds are unavailable.' }
$width = $bounds.right - $bounds.left
$height = $bounds.bottom - $bounds.top
$screenLeft = [PortcoveOwnedGameWindow]::GetSystemMetrics(76)
$screenTop = [PortcoveOwnedGameWindow]::GetSystemMetrics(77)
$screenWidth = [PortcoveOwnedGameWindow]::GetSystemMetrics(78)
$screenHeight = [PortcoveOwnedGameWindow]::GetSystemMetrics(79)
if ($width -lt 100 -or $height -lt 100 -or $width -gt 2048 -or $height -gt 2048 -or
    $bounds.left -lt $screenLeft -or $bounds.top -lt $screenTop -or
    $bounds.right -gt ($screenLeft + $screenWidth) -or $bounds.bottom -gt ($screenTop + $screenHeight)) { throw 'The observed game window is outside the complete bounded visible capture area.' }
$before = Assert-Game
if ($before.handle -ne $window -or [PortcoveOwnedGameWindow]::GetForegroundWindow() -ne $window) { throw 'Window or foreground identity changed before capture.' }
$bitmap = [Drawing.Bitmap]::new($width,$height)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($bounds.left,$bounds.top,0,0,$bitmap.Size)
    $after = Assert-Game
    $afterBounds = [PortcoveOwnedGameWindow+RECT]::new()
    [uint32]$afterOwner = 0
    [void][PortcoveOwnedGameWindow]::GetWindowThreadProcessId($window, [ref]$afterOwner)
    if ($after.handle -ne $window -or $afterOwner -ne $record.pid -or [PortcoveOwnedGameWindow]::GetForegroundWindow() -ne $window -or
        -not [PortcoveOwnedGameWindow]::GetWindowRect($window,[ref]$afterBounds) -or
        $afterBounds.left -ne $bounds.left -or $afterBounds.top -ne $bounds.top -or $afterBounds.right -ne $bounds.right -or $afterBounds.bottom -ne $bounds.bottom) { throw 'Window identity, bounds or foreground changed during pixel capture.' }
    $stream = [IO.File]::Open($ScreenshotPath,[IO.FileMode]::CreateNew)
    try { $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png) } finally { $stream.Dispose() }
} finally { $graphics.Dispose(); $bitmap.Dispose() }
$observation = [ordered]@{
    captured_at=[DateTime]::UtcNow.ToString('o'); method='owned-foreground-window-CopyFromScreen'; screenshot=$ScreenshotPath
    screenshot_sha256=(Get-FileHash -LiteralPath $ScreenshotPath -Algorithm SHA256).Hash.ToLowerInvariant()
    application_sha256=$ApplicationSha256; application=$record; supervisor=$snapshot.driver; owned_processes=$snapshot.processes
    session_id=$session; window_handle=$window.ToInt64().ToString(); window_owner_pid=$windowOwner; title=$game.title
    left=$bounds.left; top=$bounds.top; width=$width; height=$height; foreground=$true; focus_requested=$focusRequested
    visual_review='pending independent inspection of actual PNG bytes'; gameplay_claim=$false
}
$stream = [IO.File]::Open($ObservationPath,[IO.FileMode]::CreateNew)
try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($observation | ConvertTo-Json -Depth 10))
    $stream.Write($bytes,0,$bytes.Length)
} finally { $stream.Dispose() }
$observation | ConvertTo-Json -Depth 10 -Compress
