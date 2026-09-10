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
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
$tree = Get-OwnedNativeProcessTree $DriverProcessId $ApplicationPath
$application = $tree.application
$applicationFull = $application.ExecutablePath
$applicationId = [int]$application.ProcessId
function Assert-LiveApplication {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $applicationId"
    if (-not $live -or $live.CreationDate -ne $application.CreationDate -or $live.ExecutablePath -ne $application.ExecutablePath) { throw 'Owned application identity changed while waiting for confirmation.' }
}
$condition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Title),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
))
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$window = $null
while ([DateTime]::UtcNow -lt $deadline) {
    $windowScope = 'root'
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -eq 0) {
        $windowScope = 'owned-descendant'
        $ownedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId)
        $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedCondition)
        $windows = @($roots | ForEach-Object { $_.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) })
    }
    if ($windows.Count -gt 1) {
        $observed = @($windows | ForEach-Object { [pscustomobject]@{ name = $_.Current.Name; class = $_.Current.ClassName; handle = $_.Current.NativeWindowHandle } }) | ConvertTo-Json -Compress
        throw "Ambiguous native confirmation: $observed"
    }
    if ($windows.Count -eq 1) { $window = $windows[0]; break }
    Start-Sleep -Milliseconds 100
}
if (-not $window) {
    $ownedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId)
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedCondition)
    $observed = @($roots | ForEach-Object {
        [pscustomobject]@{ name = $_.Current.Name; class = $_.Current.ClassName; process = $_.Current.ProcessId }
        $_.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)) | ForEach-Object {
            [pscustomobject]@{ name = $_.Current.Name; class = $_.Current.ClassName; process = $_.Current.ProcessId }
        }
    }) | ConvertTo-Json -Compress
    throw "Owned native confirmation did not appear. Owned window observations: $observed"
}
$children = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @($children | ForEach-Object { $_.Current.Name })
$text = $names -join "`n"
if (-not $text.Contains($ExpectedText)) { throw 'Native confirmation did not name the expected reviewed target.' }
if ($FilePath) {
    Assert-LiveApplication
    if ($Button -ne 'Open' -or $Title -ne 'Choose local artwork') { throw 'File input is limited to the owned artwork picker.' }
    $selected = (Resolve-Path -LiteralPath $FilePath).Path
    if (-not [IO.File]::Exists($selected)) { throw 'Owned picker fixture is not a file.' }
    $fields = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'File name:' })
    if ($fields.Count -ne 1) { throw 'Expected one exact file-name field in the owned artwork picker.' }
    $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($selected)
}
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
Assert-LiveApplication
if ($Button -ne '__observe__') {
    $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
[pscustomobject]@{ application_pid = $applicationId; driver_pid = $DriverProcessId; application_path = $applicationFull; title = $Title; window_scope = $windowScope; button = $Button; text = $text; selected_file = $FilePath } | ConvertTo-Json -Compress
