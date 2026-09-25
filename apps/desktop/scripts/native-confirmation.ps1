param(
    [Parameter(Mandatory)][int]$DriverProcessId,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory)][string]$Title,
    [Parameter(Mandatory)][string]$ExpectedText,
    [Parameter(Mandatory)][string]$Button,
    [string]$FilePath,
    [string]$DirectoryPath
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
function Get-OwnedConfirmationWindows {
    $ownedWindows = @()
    $seen = [Collections.Generic.HashSet[string]]::new()
    $rootMatches = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    $ownedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId)
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedCondition)
    $nestedMatches = @($roots | ForEach-Object { $_.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) })
    foreach ($candidate in @($rootMatches) + @($nestedMatches)) {
        $handle = $candidate.Current.NativeWindowHandle
        $key = if ($handle) { "handle:$handle" } else { "runtime:$($candidate.GetRuntimeId() -join '.')" }
        if ($seen.Add($key)) { $ownedWindows += $candidate }
    }
    return $ownedWindows
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$window = $null
$children = @()
while ([DateTime]::UtcNow -lt $deadline) {
    $targets = @()
    foreach ($candidate in @(Get-OwnedConfirmationWindows)) {
        $candidateChildren = $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $candidateText = @($candidateChildren | ForEach-Object { $_.Current.Name }) -join "`n"
        if ($candidateText.Contains($ExpectedText)) {
            $targets += [pscustomobject]@{ window = $candidate; children = $candidateChildren; text = $candidateText }
        }
    }
    if ($targets.Count -gt 1) {
        $observed = @($targets | ForEach-Object { [pscustomobject]@{ name = $_.window.Current.Name; class = $_.window.Current.ClassName; handle = $_.window.Current.NativeWindowHandle } }) | ConvertTo-Json -Compress
        throw "Ambiguous native confirmation: $observed"
    }
    if ($targets.Count -eq 1) {
        $window = $targets[0].window
        $children = $targets[0].children
        $text = $targets[0].text
        break
    }
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
$windowScope = 'owned-exact-target'
if ($FilePath -and $DirectoryPath) { throw 'Choose only one native picker input.' }
if ($FilePath) {
    Assert-LiveApplication
    if ($Button -ne 'Open' -or $Title -notin @('Choose local artwork', 'Choose game files', 'Choose BIOS file')) { throw 'File input is limited to owned artwork or source pickers.' }
    $selected = (Resolve-Path -LiteralPath $FilePath).Path
    if (-not [IO.File]::Exists($selected)) { throw 'Owned picker fixture is not a file.' }
    $fields = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'File name:' })
    if ($fields.Count -ne 1) { throw 'Expected one exact file-name field in the owned artwork picker.' }
    $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($selected)
}
if ($DirectoryPath) {
    Assert-LiveApplication
    if ($Button -ne 'Select Folder' -or $Title -ne 'Choose Portcove library') { throw 'Directory input is limited to the owned library picker.' }
    $selected = (Resolve-Path -LiteralPath $DirectoryPath).Path
    if (-not [IO.Directory]::Exists($selected)) { throw 'Owned picker fixture is not a directory.' }
    $fields = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'Folder:' })
    if ($fields.Count -ne 1) { throw 'Expected one exact folder field in the owned library picker.' }
    $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($selected)
}
if ($Button -ne '__observe__') {
    $buttonDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $buttons = @()
    $children = @()
    do {
        # UI Automation elements can become stale while a native TaskDialog remains
        # visible. Reacquire every exact owned representation and keep only the
        # one that still names the reviewed target.
        $freshTargets = @()
        foreach ($candidate in @(Get-OwnedConfirmationWindows)) {
            $candidateChildren = $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $candidateText = @($candidateChildren | ForEach-Object { $_.Current.Name }) -join "`n"
            if ($candidateText.Contains($ExpectedText)) {
                $freshTargets += [pscustomobject]@{ window = $candidate; children = $candidateChildren; text = $candidateText }
            }
        }
        if ($freshTargets.Count -gt 1) { throw 'Ambiguous native confirmation while waiting for its button.' }
        if ($freshTargets.Count -eq 0) {
            Start-Sleep -Milliseconds 100
            continue
        }
        $window = $freshTargets[0].window
        $children = $freshTargets[0].children
        $text = $freshTargets[0].text
        $buttons = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $Button })
        if ($buttons.Count -gt 1) { throw 'Ambiguous native confirmation button.' }
        if ($buttons.Count -eq 1 -and $buttons[0].Current.IsEnabled) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $buttonDeadline)
    if ($buttons.Count -ne 1 -or -not $buttons[0].Current.IsEnabled) {
        $observed = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -or $_.Current.AutomationId -in @('1', '2') } | ForEach-Object { [pscustomobject]@{ name = $_.Current.Name; automation_id = $_.Current.AutomationId; class = $_.Current.ClassName; control_type = $_.Current.ControlType.ProgrammaticName; enabled = $_.Current.IsEnabled } }) | ConvertTo-Json -Compress
        throw "Expected one enabled native confirmation button '$Button'; observed: $observed"
    }
}
Assert-LiveApplication
if ($Button -ne '__observe__') {
    $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
[pscustomobject]@{ application_pid = $applicationId; driver_pid = $DriverProcessId; application_path = $applicationFull; title = $Title; window_scope = $windowScope; button = $Button; text = $text; selected_file = $FilePath; selected_directory = $DirectoryPath } | ConvertTo-Json -Compress
