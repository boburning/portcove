param(
    [Parameter(Mandatory)][int]$DriverProcessId,
    [Parameter(Mandatory)][string]$ApplicationPath,
    [Parameter(Mandatory, ParameterSetName='Confirmation')][string]$Title,
    [Parameter(Mandatory, ParameterSetName='Confirmation')][string]$ExpectedText,
    [Parameter(Mandatory, ParameterSetName='Confirmation')][string]$Button,
    [Parameter(ParameterSetName='Confirmation')][string]$FilePath,
    [Parameter(ParameterSetName='Confirmation')][string]$DirectoryPath,
    [Parameter(ParameterSetName='Confirmation')][string]$ScreenshotPath,
    [Parameter(Mandatory, ParameterSetName='Observation')][switch]$ObservePicker,
    [Parameter(Mandatory, ParameterSetName='Observation')][string]$ExpectedDriverPath,
    [Parameter(Mandatory, ParameterSetName='Observation')][ValidatePattern('^[0-9]+$')][string]$ExpectedDriverStartedFiletime,
    [Parameter(Mandatory, ParameterSetName='Observation')][string]$ObservationPath,
    [Parameter(ParameterSetName='Observation')][string]$PreparedRuntimeDirectory
)
$ErrorActionPreference = 'Stop'
$script:lastNativeStage = 'setup'
$script:pickerFieldEvidence = $null
function Get-PickerFieldEvidence($Children, [int]$FolderMatches = -1) {
    $all = @($Children)
    $edits = @($Children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit })
    $samples = @($edits | Select-Object -First 32 | ForEach-Object {
        $current = $_.Current
        [pscustomobject]@{
            name_kind = $(if ($current.Name -eq 'Folder:') { 'folder' } elseif ($current.Name -eq 'File name:') { 'file-name' } elseif ($current.Name -eq 'Folder name:') { 'folder-name' } elseif ([string]::IsNullOrEmpty($current.Name)) { 'empty' } else { 'other' })
            automation_id = $(if ($current.AutomationId -cmatch '^[0-9]{1,8}$') { $current.AutomationId } else { 'other' })
            owned = ($current.ProcessId -eq $applicationId)
            enabled = [bool]$current.IsEnabled
        }
    })
    [pscustomobject]@{ edit_count = $edits.Count; samples = $samples; truncated = ($edits.Count -gt 32)
        folder_matches = $FolderMatches
        total_count = $all.Count
        automation_element_count = @($all | Where-Object { $_ -is [System.Windows.Automation.AutomationElement] }).Count
        folder_label_count = @($all | Where-Object { $_.Current.Name -eq 'Folder:' }).Count
        owned_folder_matches = @($edits | Where-Object { $_.Current.Name -eq 'Folder:' -and $_.Current.ProcessId -eq $applicationId }).Count
        folder_name_matches = @($edits | Where-Object { $_.Current.Name -eq 'Folder name:' }).Count
        file_name_matches = @($edits | Where-Object { $_.Current.Name -eq 'File name:' }).Count
        empty_name_matches = @($edits | Where-Object { [string]::IsNullOrEmpty($_.Current.Name) }).Count }
}
function Get-NativeFailureEvidence([Management.Automation.ErrorRecord]$Record) {
    # Only fixed identifiers and numeric locations/codes leave the helper.
    # Exception messages, source lines, target objects and full paths are private.
    $stages = @('setup', 'automation-assemblies-start', 'automation-assemblies-ready',
        'owned-process-tree-start', 'owned-process-tree-ready', 'exact-root-discovery-start',
        'exact-root-discovery-ready', 'owned-root-discovery-start', 'owned-root-discovery-ready',
        'nested-discovery-start', 'nested-discovery-ready', 'candidate-descendants-start',
        'candidate-descendants-ready', 'candidate-text-ready', 'timeout-roots-start',
        'timeout-nested-start', 'button-descendants-start', 'button-descendants-ready',
        'target-identity-rechecked', 'screenshot-preparation-start', 'screenshot-written',
        'observation-complete')
    $stage = if ($script:lastNativeStage -cin $stages) { $script:lastNativeStage } else { 'unknown' }
    $types = @('System.Exception', 'System.InvalidOperationException', 'System.ArgumentException',
        'System.IO.IOException', 'System.UnauthorizedAccessException',
        'System.Runtime.InteropServices.COMException', 'System.Management.Automation.RuntimeException',
        'System.Management.Automation.MethodInvocationException',
        'System.Management.Automation.ActionPreferenceStopException',
        'System.Windows.Automation.ElementNotAvailableException',
        'System.Windows.Automation.ElementNotEnabledException')
    $details = @()
    $exception = $Record.Exception
    for ($index = 0; $exception -and $index -lt 4; $index++) {
        $type = $exception.GetType().FullName
        $details += [pscustomobject]@{
            type = $(if ($type -cin $types) { $type } else { 'other' })
            hresult = ('0x{0:X8}' -f $exception.HResult)
        }
        $exception = $exception.InnerException
    }
    $location = $null
    if ($Record.InvocationInfo -and $Record.InvocationInfo.ScriptLineNumber -gt 0) {
        $scriptName = [IO.Path]::GetFileName($Record.InvocationInfo.ScriptName)
        $location = [pscustomobject]@{
            script = $(if ($scriptName -cin @('native-confirmation.ps1', 'native-process-tree.ps1')) { $scriptName } else { 'other' })
            line = $Record.InvocationInfo.ScriptLineNumber; column = $Record.InvocationInfo.OffsetInLine
        }
    }
    [pscustomobject]@{ format_version = 1; stage = $stage; location = $location
        exceptions = $details; exceptions_truncated = [bool]$exception
        picker_fields = $script:pickerFieldEvidence }
}
trap {
    $nativeFailure = $_
    try {
        $diagnostic = Get-NativeFailureEvidence $nativeFailure | ConvertTo-Json -Depth 7 -Compress
        [Console]::Error.WriteLine("PORTCOVE_NATIVE_FAILURE $diagnostic")
    } catch { $null = $_ } # Secondary diagnostics must never replace the original error.
    break
}
$progressPath = $null
if ($ScreenshotPath) {
    if (-not [IO.Path]::IsPathFullyQualified($ScreenshotPath) -or
        [IO.File]::Exists($ScreenshotPath) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($ScreenshotPath))) {
        throw 'Native screenshot requires a fresh file in the existing owned output directory.'
    }
    $progressPath = "$ScreenshotPath.progress.jsonl"
    $progressStream = [IO.File]::Open($progressPath, [IO.FileMode]::CreateNew)
    $progressStream.Dispose()
}
function Write-ObservationProgress([string]$Stage) {
    $script:lastNativeStage = $Stage
    if ($progressPath) {
        $record = [pscustomobject]@{ stage = $Stage; observed_at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
        [IO.File]::AppendAllText($progressPath, "$record`n")
    }
}
Write-ObservationProgress 'automation-assemblies-start'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Write-ObservationProgress 'automation-assemblies-ready'
. (Join-Path $PSScriptRoot 'native-process-tree.ps1')
function Assert-CapturedPickerDriver([string]$DriverPath, [string]$DriverStartedFiletime) {
    $capturedDriver = [Diagnostics.Process]::GetProcessById($DriverProcessId)
    if ($capturedDriver.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $DriverStartedFiletime -or
        -not [string]::Equals($capturedDriver.MainModule.FileName, $DriverPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Captured picker driver identity changed; no input permitted.'
    }
}
if ($ObservePicker) {
    if (-not [IO.Path]::IsPathFullyQualified($ObservationPath) -or [IO.File]::Exists($ObservationPath) -or
        -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($ObservationPath))) { throw 'Picker observation requires a fresh owned output file.' }
    Assert-CapturedPickerDriver $ExpectedDriverPath $ExpectedDriverStartedFiletime
    if ($PreparedRuntimeDirectory) {
        $expectedPreparedDirectory = [IO.Path]::Combine([IO.Path]::GetDirectoryName($ObservationPath), 'player-owned-runtime')
        if (-not [IO.Path]::IsPathFullyQualified($PreparedRuntimeDirectory) -or
            -not [string]::Equals([IO.Path]::GetFullPath($PreparedRuntimeDirectory), $expectedPreparedDirectory, [StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.Directory]::Exists($PreparedRuntimeDirectory) -or
            ([IO.File]::GetAttributes($PreparedRuntimeDirectory) -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Prepared runtime input requires the exact regular owned fixture directory.'
        }
    }
}
Write-ObservationProgress 'owned-process-tree-start'
$tree = Get-OwnedNativeProcessTree $DriverProcessId $ApplicationPath
Write-ObservationProgress 'owned-process-tree-ready'
$application = $tree.application
$applicationFull = $application.ExecutablePath
$applicationId = [int]$application.ProcessId
function Assert-LiveApplication {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $applicationId"
    if (-not $live -or $live.CreationDate -ne $application.CreationDate -or $live.ExecutablePath -ne $application.ExecutablePath) { throw 'Owned application identity changed while waiting for confirmation.' }
    $liveDriver = Get-CimInstance Win32_Process -Filter "ProcessId = $DriverProcessId"
    if (-not $liveDriver -or $liveDriver.CreationDate -ne $tree.driver.CreationDate -or $liveDriver.ExecutablePath -ne $tree.driver.ExecutablePath) { throw 'Owned driver identity changed while waiting for confirmation.' }
}
if ($ObservePicker) {
    # Observation cancels without input. Prepared selection is separately limited
    # to the exact regular fixture directory and the independently observed title.
    $ownedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId)
    $fieldCondition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Folder:')
    ))
    $observedWindow = $null
    $lastWindowSample = $null
    $windowSamplesPath = "$ObservationPath.window-samples.jsonl"
    $windowSamplesStream = [IO.File]::Open($windowSamplesPath, [IO.FileMode]::CreateNew)
    $windowSamplesStream.Dispose()
    $observationDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $observationDeadline) {
        Assert-CapturedPickerDriver $ExpectedDriverPath $ExpectedDriverStartedFiletime
        Assert-LiveApplication
        $windows = @{}
        $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedCondition)
        $sampleData = @($roots | ForEach-Object {
            $items = @($_.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object {
                $_.Current.ProcessId -eq $applicationId -and $_.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::Window)
            })
            [pscustomobject]@{
                title = $_.Current.Name; handle = $_.Current.NativeWindowHandle; process = $_.Current.ProcessId; class = $_.Current.ClassName
                control_count = $items.Count; controls_truncated = $items.Count -gt 100
                controls = @($items | Select-Object -First 100 | ForEach-Object {
                    [pscustomobject]@{ name = $_.Current.Name; process = $_.Current.ProcessId; type = $_.Current.ControlType.ProgrammaticName; handle = $_.Current.NativeWindowHandle }
                })
            }
        })
        $sample = ConvertTo-Json -InputObject $sampleData -Depth 6 -Compress
        if ($sample -cne $lastWindowSample) {
            Assert-CapturedPickerDriver $ExpectedDriverPath $ExpectedDriverStartedFiletime
            Assert-LiveApplication
            $line = [pscustomobject]@{ at = [DateTime]::UtcNow.ToString('o'); application_pid = $applicationId; owned_window_sample = $sampleData } | ConvertTo-Json -Depth 7 -Compress
            [IO.File]::AppendAllText($windowSamplesPath, "$line`n")
            $lastWindowSample = $sample
        }
        foreach ($root in $roots) {
            foreach ($field in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $fieldCondition)) {
                $ancestor = $field
                do { $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor) }
                while ($ancestor -and $ancestor.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window)
                if ($ancestor -and $ancestor.Current.ProcessId -eq $applicationId -and $ancestor.Current.NativeWindowHandle) {
                    $windows[[string]$ancestor.Current.NativeWindowHandle] = $ancestor
                }
            }
        }
        if ($windows.Count -gt 1) { throw 'Ambiguous owned native folder window; no input supplied.' }
        if ($windows.Count -eq 1) { $observedWindow = @($windows.Values)[0]; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $observedWindow) { throw 'No unique owned native folder window observed; no input supplied.' }
    $controls = $observedWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $fields = @($controls | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'Folder:' })
    $buttonName = if ($PreparedRuntimeDirectory) { 'Select Folder' } else { 'Cancel' }
    if ($PreparedRuntimeDirectory -and $observedWindow.Current.Name -ne 'Select Folder') { throw 'Prepared runtime selection requires the observed exact Select Folder title.' }
    $actionButton = @($controls | Where-Object { $_.Current.ProcessId -eq $applicationId -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $buttonName -and $_.Current.IsEnabled })
    if ($fields.Count -ne 1 -or $fields[0].Current.ProcessId -ne $applicationId -or $actionButton.Count -ne 1) { throw 'Owned picker requires one exact owned Folder field and action button.' }
    $observation = [ordered]@{
        observed_at = [DateTime]::UtcNow.ToString('o'); title = $observedWindow.Current.Name
        handle = $observedWindow.Current.NativeWindowHandle; class = $observedWindow.Current.ClassName
        application_pid = $applicationId; application_created_at = $application.CreationDate.ToUniversalTime().ToString('o')
        application_path = $applicationFull; driver_pid = $DriverProcessId
        driver_created_at = $tree.driver.CreationDate.ToUniversalTime().ToString('o')
        field_names = @($fields | ForEach-Object { $_.Current.Name })
        button_names = @($controls | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | ForEach-Object { $_.Current.Name })
        supplied_directory = $false; cancelled = $false; selected = $false; action = $buttonName
    }
    $freshTree = Get-OwnedNativeProcessTree $DriverProcessId $ApplicationPath
    if ($freshTree.driver.CreationDate -ne $tree.driver.CreationDate -or $freshTree.application.CreationDate -ne $application.CreationDate) { throw 'Owned picker process identity changed before cancellation.' }
    $beforeBytes = [Text.Encoding]::UTF8.GetBytes(($observation | ConvertTo-Json -Depth 5))
    $beforeStream = [IO.File]::Open($ObservationPath, [IO.FileMode]::CreateNew)
    try { $beforeStream.Write($beforeBytes, 0, $beforeBytes.Length) } finally { $beforeStream.Dispose() }
    Assert-CapturedPickerDriver $ExpectedDriverPath $ExpectedDriverStartedFiletime
    Assert-LiveApplication
    if ($PreparedRuntimeDirectory) {
        $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($PreparedRuntimeDirectory)
        $observation.supplied_directory = $true
        Assert-CapturedPickerDriver $ExpectedDriverPath $ExpectedDriverStartedFiletime
        Assert-LiveApplication
    }
    $actionButton[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $cancelDeadline = [DateTime]::UtcNow.AddSeconds(2)
    $closeSamples = @()
    $closeCondition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        $ownedCondition,
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]$observation.handle),
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    ))
    do {
        Assert-CapturedPickerDriver $ExpectedDriverPath $ExpectedDriverStartedFiletime
        Assert-LiveApplication
        # A saved UIA element may continue to expose its old handle after Cancel.
        # Re-enumerate the exact application's live windows instead of treating
        # that retained value as evidence the dialog is still present.
        $liveRoots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedCondition)
        $liveHandles = [Collections.Generic.HashSet[int]]::new()
        foreach ($root in $liveRoots) {
            if ($root.Current.NativeWindowHandle -eq $observation.handle) { [void]$liveHandles.Add([int]$root.Current.NativeWindowHandle) }
            foreach ($nested in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $closeCondition)) {
                [void]$liveHandles.Add([int]$nested.Current.NativeWindowHandle)
            }
        }
        $present = $liveHandles.Contains([int]$observation.handle)
        try { $retainedHandle = $observedWindow.Current.NativeWindowHandle }
        catch [System.Windows.Automation.ElementNotAvailableException] { $retainedHandle = $null }
        $closeSamples += [pscustomobject]@{ at = [DateTime]::UtcNow.ToString('o'); retained_uia_handle = $retainedHandle; fresh_owned_window_present = $present }
        if (-not $present) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $cancelDeadline)
    $closeBytes = [Text.Encoding]::UTF8.GetBytes(($closeSamples | ConvertTo-Json -Depth 4))
    $closeStream = [IO.File]::Open("$ObservationPath.close-samples.json", [IO.FileMode]::CreateNew)
    try { $closeStream.Write($closeBytes, 0, $closeBytes.Length) } finally { $closeStream.Dispose() }
    if ($present) { throw 'Observed owned picker did not close after its exact action.' }
    $observation.cancelled = -not [bool]$PreparedRuntimeDirectory
    $observation.selected = [bool]$PreparedRuntimeDirectory
    $observation | ConvertTo-Json -Depth 5 -Compress
    exit 0
}
. (Join-Path $PSScriptRoot 'native-window-discovery.ps1')
$condition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Title),
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
))
function Get-OwnedConfirmationWindows {
    if ($DirectoryPath) { return Get-OwnedLibraryPickerWindows }
    $ownedWindows = @()
    $seen = [Collections.Generic.HashSet[string]]::new()
    Write-ObservationProgress 'exact-root-discovery-start'
    $rootMatches = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    Write-ObservationProgress 'exact-root-discovery-ready'
    $ownedCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $applicationId)
    Write-ObservationProgress 'owned-root-discovery-start'
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $ownedCondition)
    Write-ObservationProgress 'owned-root-discovery-ready'
    Write-ObservationProgress 'nested-discovery-start'
    $nestedMatches = @($roots | ForEach-Object { $_.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition) })
    Write-ObservationProgress 'nested-discovery-ready'
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
        Write-ObservationProgress 'candidate-descendants-start'
        $candidateChildren = $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        Write-ObservationProgress 'candidate-descendants-ready'
        $candidateText = @($candidateChildren | ForEach-Object { $_.Current.Name }) -join "`n"
        Write-ObservationProgress 'candidate-text-ready'
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
    $observed = @(Get-OwnedConfirmationWindows | ForEach-Object {
        [pscustomobject]@{ name = $_.Current.Name; class = $_.Current.ClassName; process = $_.Current.ProcessId }
    }) | ConvertTo-Json -Compress
    throw "Owned native confirmation did not appear. Owned window observations: $observed"
}
$windowScope = 'owned-exact-target'
if ($FilePath -and $DirectoryPath) { throw 'Choose only one native picker input.' }
if ($FilePath) {
    Assert-ExactConfirmationWindow $window
    if ($Button -ne 'Open' -or $Title -notin @('Choose local artwork', 'Choose game files', 'Choose ZIP file', 'Choose BIOS file')) { throw 'File input is limited to artwork, game-file, and BIOS pickers.' }
    $selected = (Resolve-Path -LiteralPath $FilePath).Path
    if (-not [IO.File]::Exists($selected)) { throw 'Owned picker fixture is not a file.' }
    $fields = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'File name:' })
    if ($fields.Count -ne 1) { throw 'Expected one exact file-name field in the owned artwork picker.' }
    $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($selected)
}
if ($DirectoryPath) {
    Assert-ExactConfirmationWindow $window
    if ($Button -ne 'Select Folder' -or $Title -ne 'Choose Portcove library') { throw 'Directory input is limited to the owned library picker.' }
    $selected = (Resolve-Path -LiteralPath $DirectoryPath).Path
    if (-not [IO.Directory]::Exists($selected)) { throw 'Owned picker fixture is not a directory.' }
    $fields = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'Folder:' })
    if ($fields.Count -ne 1 -or $fields[0].Current.ProcessId -ne $applicationId) {
        try { $script:pickerFieldEvidence = Get-PickerFieldEvidence $children $fields.Count } catch { $null = $_ }
        throw 'Expected one exact owned folder field in the library picker.'
    }
    $fields[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($selected)
}
$selectedWindowHandle = $window.Current.NativeWindowHandle
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
            Write-ObservationProgress 'button-descendants-start'
            $candidateChildren = $candidate.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            Write-ObservationProgress 'button-descendants-ready'
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
        if ($DirectoryPath -and $window.Current.NativeWindowHandle -ne $selectedWindowHandle) {
            throw 'Owned picker window changed after selection; no input permitted.'
        }
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
Write-ObservationProgress 'target-identity-rechecked'
$screenshotObservation = $null
if ($ScreenshotPath) {
    Write-ObservationProgress 'screenshot-preparation-start'
    $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    if (-not [Environment]::UserInteractive -or $sessionId -le 0 -or
        $application.SessionId -ne $sessionId -or $tree.driver.SessionId -ne $sessionId -or
        @($tree.processes | Where-Object { $_.SessionId -ne $sessionId }).Count -gt 0) {
        throw 'Native screenshot requires the harness, driver and application in one interactive session.'
    }
    if (-not [IO.Path]::IsPathFullyQualified($ScreenshotPath) -or
        [IO.File]::Exists($ScreenshotPath) -or -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($ScreenshotPath))) {
        throw 'Native screenshot requires a fresh file in the existing owned output directory.'
    }
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PortcoveConsentWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
    $bounds = $window.Current.BoundingRectangle
    if ($window.Current.IsOffscreen -or $bounds.Width -le 0 -or $bounds.Height -le 0 -or
        $bounds.Width -gt 4096 -or $bounds.Height -gt 4096 -or
        [PortcoveConsentWindow]::GetForegroundWindow().ToInt64() -ne $window.Current.NativeWindowHandle) {
        throw 'Exact owned native consent must be visible and foreground before its screenshot.'
    }
    $width = [int][Math]::Ceiling($bounds.Width)
    $height = [int][Math]::Ceiling($bounds.Height)
    $bitmap = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
        Assert-LiveApplication
        if ([PortcoveConsentWindow]::GetForegroundWindow().ToInt64() -ne $window.Current.NativeWindowHandle) {
            throw 'Native foreground ownership changed during capture.'
        }
        $stream = [IO.File]::Open($ScreenshotPath, [IO.FileMode]::CreateNew)
        try { $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png) } finally { $stream.Dispose() }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Write-ObservationProgress 'screenshot-written'
    $screenshotObservation = [pscustomobject]@{
        path = $ScreenshotPath; width = $width; height = $height; session_id = $sessionId
        window_handle = $window.Current.NativeWindowHandle; foreground = $true
        application_created_at = $application.CreationDate; driver_created_at = $tree.driver.CreationDate
        owned_processes = @($tree.processes | ForEach-Object {
            [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath; created_at = $_.CreationDate; session_id = $_.SessionId }
        })
    }
}
Write-ObservationProgress 'observation-complete'
if ($Button -ne '__observe__') {
    Assert-ExactConfirmationWindow $window
    if ($DirectoryPath -and $buttons[0].Current.ProcessId -ne $applicationId) { throw 'Owned library picker button identity changed; no input permitted.' }
    $buttons[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
[pscustomobject]@{ application_pid = $applicationId; driver_pid = $DriverProcessId; application_path = $applicationFull; title = $Title; window_scope = $windowScope; button = $Button; text = $text; selected_file = $FilePath; selected_directory = $DirectoryPath; screenshot = $screenshotObservation } | ConvertTo-Json -Depth 4 -Compress
