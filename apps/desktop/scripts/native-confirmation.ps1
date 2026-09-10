param(
    [Parameter(Mandatory)][int]$DriverProcessId,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$ExpectedText,
    [Parameter(Mandatory)][string]$Button,
    [string]$FilePath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$applicationFull = (Resolve-Path -LiteralPath $ApplicationPath).Path
$processes = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($entry in $processes) { $byId[[int]$entry.ProcessId] = $entry }
if (-not $byId.ContainsKey($DriverProcessId)) { throw 'Owned driver is no longer running.' }
$applications = @($processes | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $applicationFull, [StringComparison]::OrdinalIgnoreCase) } | Where-Object {
    $ancestor = [int]$_.ParentProcessId
    $seen = [Collections.Generic.HashSet[int]]::new()
    while ($ancestor -ne $DriverProcessId -and $byId.ContainsKey($ancestor) -and $seen.Add($ancestor)) { $ancestor = [int]$byId[$ancestor].ParentProcessId }
    $ancestor -eq $DriverProcessId
})
if ($applications.Count -ne 1) { throw 'Expected exactly one owned application descended from the selected driver.' }
$applicationId = [int]$applications[0].ProcessId
$condition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
)
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$window = $null
while ([DateTime]::UtcNow -lt $deadline) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -gt 1) { throw 'Ambiguous native confirmation.' }
    if ($windows.Count -eq 1) { $window = $windows[0]; break }
    Start-Sleep -Milliseconds 100
}
if (-not $window) { throw 'Owned native confirmation did not appear.' }
$children = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($children | ForEach-Object { $_.Current.Name })
$text = $names -join "`n"
if (-not $text.Contains($ExpectedText)) { throw 'Native confirmation did not name the expected reviewed target.' }
if ($Button -ne '__observe__') {
    do {
        $children = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $text = @($children | ForEach-Object { $_.Current.Name }) -join "`n"
        if (-not $text.Contains($ExpectedText)) { throw 'Native confirmation target changed while waiting for its button.' }
        $buttons = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $Button })
        if ($buttons.Count -gt 1) { throw 'Ambiguous native confirmation button.' }
        if ($buttons.Count -eq 1 -and $buttons[0].Current.IsEnabled) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($buttons.Count -ne 1 -or -not $buttons[0].Current.IsEnabled) {
        $observed = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | ForEach-Object { [pscustomobject]@{ name = $_.Current.Name; enabled = $_.Current.IsEnabled } }) | ConvertTo-Json -Compress
        throw "Expected one enabled native confirmation button '$Button'; observed: $observed"
    }
}
$liveApplication = Get-CimInstance Win32_Process -Filter "ProcessId = $applicationId"
if (-not $liveApplication -or $liveApplication.CreationDate -ne $applications[0].CreationDate -or $liveApplication.ExecutablePath -ne $applications[0].ExecutablePath) { throw 'Owned application identity changed while waiting for confirmation.' }
if ($FilePath) {
    if ($Button -ne 'Open' -or $Title -ne 'Choose local artwork') { throw 'File input is limited to the owned artwork picker.' }
    $selected = (Resolve-Path -LiteralPath $FilePath).Path
    if (-not [IO.File]::Exists($selected)) { throw 'Owned picker fixture is not a file.' }
    $fields = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'File name:' })
    if ($fields.Count -ne 1) { throw 'Expected one exact file-name field in the owned artwork picker.' }
    $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($selected)
}
if ($Button -ne '__observe__') {
    $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
[pscustomobject]@{ application_pid = $applicationId; driver_pid = $DriverProcessId; application_path = $applicationFull; title = $Title; button = $Button; text = $text; selected_file = $FilePath } | ConvertTo-Json -Compress
