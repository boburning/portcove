param(
    [Parameter(Mandatory)][string]$Plan,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

# Fixed, credential-free owner-side plumbing. A file or successful script exit
# cannot produce a native Check: only the installed parent retains provenance.
function Assert-DriverOwnerPath([string]$Path) {
    $item=Get-Item -LiteralPath $Path -Force
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl=Get-Acl -LiteralPath $Path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner) { throw 'Native driver input custody differs' }
    $write=[Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and
            $rule.IdentityReference.Value -notin @($owner,'S-1-5-18','S-1-5-32-544')) {throw 'Native driver input permits a foreign writer'}
    }
    $cursor=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path));$depth=0
    $replace=[Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    while($cursor) {
        if(++$depth -gt 64){throw 'Native driver ancestry exceeds bound'}
        $item=Get-Item -LiteralPath $cursor -Force
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Native driver ancestor is a reparse point'}
        foreach($rule in (Get-Acl -LiteralPath $cursor).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
                $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $replace) -and
                $rule.IdentityReference.Value -notin @($owner,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) {
                throw 'Native driver ancestor permits replacement'
            }
        }
        $next=[IO.Path]::GetDirectoryName($cursor);if(-not $next -or $next -eq $cursor){break};$cursor=$next
    }
}
function Assert-DriverStageSelection($Value) {
    if($Value.schema_version -eq 2) {
        if($Value.stage -cne 'ordinary-public-initial' -or $null -ne $Value.journey -or $null -ne $Value.predecessor -or
            (@($Value.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'boundary,invocation_id,journey,package,predecessor,public_inputs,request_sha256,schema_version,stage,tools,version' -or
            (@($Value.public_inputs.PSObject.Properties.Name|Sort-Object)-join ',') -cne 'path,sha256' -or
            $Value.public_inputs.sha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'Public driver plan differs from its separate fixed initial journey'}
        return
    }
    if($Value.schema_version -ne 1) {throw 'Native driver schema differs'}
    if($Value.stage -cnotin @('payload-signing','release-publication')) {throw 'Native stage differs'}
if($Value.stage -ceq 'payload-signing' -and ($null -ne $Value.journey -or $null -ne $Value.predecessor)) {throw 'Pre-sign driver cannot accept a publication journey'}
if($Value.stage -ceq 'release-publication') {
    if($null -eq $Value.journey) {throw 'Post-sign driver journey absent'}
    $initial=$Value.journey.PSObject.Properties.Name -ccontains 'kind'
    if($initial) {
        if($Value.journey.kind -cne 'initial-empty-feed' -or $null -ne $Value.predecessor) {throw 'Initial package driver cannot claim a predecessor'}
    } elseif($null -eq $Value.predecessor -or $Value.predecessor.sha256 -cne $Value.journey.predecessor.package.sha256 -or
        $Value.predecessor.bytes -ne $Value.journey.predecessor.package.bytes) {throw 'Post-sign original predecessor differs'}
}
}
function Read-DriverJson([string]$Path,[string]$Sha) {
    Assert-DriverOwnerPath $Path
    $item=Get-Item -LiteralPath $Path -Force
    if($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt 32768 -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha) {throw 'Native driver input identity differs'}
    Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json
}
function Write-NewDriverJson([string]$Path,$Value) {
    $file=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress));$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Start-DriverChild([string]$Name,[string[]]$Arguments) {
    $start=[Diagnostics.ProcessStartInfo]::new($planValue.tools.powershell.path)
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$boundary.controller_root
    $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.RedirectStandardInput=$true
    $start.Environment.Clear()
    foreach($entry in $childEnvironment.GetEnumerator()){$start.Environment[$entry.Key]=$entry.Value}
    foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::Start($start);$process.StandardInput.Close()
    $output=[Portcove.NativeQualification.NativePipeCapture]::new($process.StandardOutput.BaseStream)
    $errorOutput=[Portcove.NativeQualification.NativePipeCapture]::new($process.StandardError.BaseStream)
    [pscustomobject]@{name=$Name;process=$process;pid=$process.Id;created=$process.StartTime.ToFileTimeUtc().ToString();stdout=$output;stderr=$errorOutput;written=@{stdout=0L;stderr=0L}}
}
function Save-DriverStreams($Child) {
    foreach($name in @('stdout','stderr')) {
        $bytes=$Child.$name.Snapshot();$offset=$Child.written[$name]
        $filePath=Join-Path $capture ($Child.name+'.'+$name+'.bin')
        $mode=if($offset -eq 0 -and -not [IO.File]::Exists($filePath)){[IO.FileMode]::CreateNew}else{[IO.FileMode]::Open}
        $file=[IO.FileStream]::new($filePath,$mode,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try {
            if($file.Length -ne $offset -or $bytes.Length -lt $offset){throw 'Native driver retained stream changed'}
            $file.Position=$offset
            if($bytes.Length -gt $offset){$file.Write($bytes,[int]$offset,$bytes.Length-[int]$offset);$file.Flush($true)}
            $Child.written[$name]=[long]$bytes.Length
        }finally{$file.Dispose()}
        if($Child.$name.Completion.IsFaulted){$Child.$name.Completion.GetAwaiter().GetResult()|Out-Null}
    }
}
function Assert-DriverTool($Tool,[long]$Maximum) {
    Assert-DriverOwnerPath $Tool.path
    $item=Get-Item -LiteralPath $Tool.path -Force
    if($item.PSIsContainer -or $item.Length -lt 1 -or $item.Length -gt $Maximum -or
        (Get-FileHash -LiteralPath $Tool.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Tool.sha256){throw 'Fixed native driver tool differs'}
}
function Read-DriverHostObservation {
    $runtimePath=Join-Path $capture 'isolated-account-desktop\native-runtime-capabilities.json'
    Assert-DriverOwnerPath $runtimePath
    if((Get-Item -LiteralPath $runtimePath).Length -gt 131072){throw 'Native runtime observation exceeds its bound'}
    $runtime=Get-Content -LiteralPath $runtimePath -Raw|ConvertFrom-Json
    if($runtime.schema_version -ne 1 -or $runtime.authority -cne 'none' -or
        $runtime.account_binding_sha256 -cne $bindingSha -or @($runtime.loaded_engine_images).Count -lt 1 -or
        @($runtime.loaded_engine_images).Count -gt 4){throw 'Native runtime observation differs from the fixed account invocation'}
    $engines=@($runtime.loaded_engine_images|ForEach-Object{
        $item=Get-Item -LiteralPath $_.path -Force
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -gt 268435456 -or $item.Length -ne $_.bytes -or $item.Name -ine 'msedgewebview2.exe' -or
            (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $_.sha256){throw 'Actual loaded WebView image changed'}
        $version=([Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName).FileVersion -split ' ')[0]
        if($version -cnotmatch '^[0-9]+(?:[.][0-9]+){1,3}$' -or
            (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $_.sha256){throw 'Actual loaded WebView image/version is unavailable or changed'}
        [ordered]@{path=$item.FullName;bytes=$item.Length;sha256=$_.sha256;version=$version}
    })
    $machine=[string](Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid)
    if($machine -cnotmatch '^[a-fA-F0-9-]{32,36}$'){throw 'Native machine identity is unavailable'}
    $machineBytes=[Text.UTF8Encoding]::new($false).GetBytes($machine.ToLowerInvariant())
    $machineSha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($machineBytes)).ToLowerInvariant()
    [ordered]@{machine_id_sha256=$machineSha;os_version=[Environment]::OSVersion.Version.ToString();
        architecture=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString();
        runtime_sha256=(Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant();engine_images=$engines}
}

$planValue=Read-DriverJson $Plan $ExpectedPlanSha256
if($planValue.invocation_id -cnotmatch '^[a-f0-9]{64}$' -or
    $planValue.request_sha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'Native driver plan differs'}
Assert-DriverStageSelection $planValue
$publicMode=$planValue.schema_version -eq 2
$boundary=Read-DriverJson $planValue.boundary.path $planValue.boundary.sha256
$capture=Join-Path $boundary.capture_root ('native-attempt-'+$planValue.invocation_id)
if([IO.Path]::GetFullPath($Plan) -cne (Join-Path $capture 'windows-plan.json') -or
    [IO.Path]::GetFullPath($PSScriptRoot) -cne (Join-Path $boundary.controller_root 'scripts')) {throw 'Native driver is outside the fixed parent/capture'}
Assert-DriverOwnerPath $capture
if($publicMode) {
    if([IO.Path]::GetFullPath($planValue.public_inputs.path) -cne (Join-Path $capture 'public-inputs.json')) {throw 'Public driver input is outside its exact claim leaf'}
    $publicInputs=Read-DriverJson $planValue.public_inputs.path $planValue.public_inputs.sha256
    if($publicInputs.prior_installer_sha256 -cne $planValue.package.sha256 -or $publicInputs.prior_version -cne $planValue.version) {throw 'Public driver initial package differs'}
}
$acl=Get-Acl -LiteralPath $capture
# Owner-only inheritance is made explicit on this new owned leaf. Existing
# roots and all existing access entries remain unchanged; no new rights granted.
$acl.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $capture -AclObject $acl
if(-not (Get-Acl -LiteralPath $capture).AreAccessRulesProtected){throw 'Native capture inheritance is not protected'}
Assert-DriverTool $planValue.tools.powershell (64MB)
Assert-DriverTool $planValue.tools.git (128MB)
Assert-DriverTool $planValue.tools.desktop_tools.node (128MB)
Assert-DriverTool $planValue.tools.desktop_tools.tauri_driver (128MB)
Assert-DriverTool $planValue.tools.desktop_tools.webview_driver (128MB)
if([Environment]::ProcessPath -cne $planValue.tools.powershell.path){throw 'Native driver PowerShell differs'}
if($PSVersionTable.PSVersion.Major -lt 7){throw 'Native driver requires the qualified PowerShell7 runtime'}
$helper=Join-Path $PSScriptRoot 'native-qualification-account.cs.txt'
Assert-DriverOwnerPath $helper
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $boundary.helper_sha256){throw 'Native fixed account helper differs'}
Add-Type -TypeDefinition (Get-Content -LiteralPath $helper -Raw)
Import-Module (Join-Path $PSScriptRoot 'native-qualification-account-adapter.psm1') -Force
$work=Join-Path $boundary.work_root $planValue.invocation_id
$null=New-Item -ItemType Directory -Path $work -ErrorAction Stop
$inputRoot=Join-Path $boundary.controller_root '.native-inputs'
if(-not [IO.Directory]::Exists($inputRoot)){$null=New-Item -ItemType Directory -Path $inputRoot -ErrorAction Stop}
Assert-DriverOwnerPath $inputRoot
$inputDirectory=Join-Path $inputRoot $planValue.invocation_id
$null=New-Item -ItemType Directory -Path $inputDirectory -ErrorAction Stop
$filename=[IO.Path]::GetFileName($planValue.package.path)
if($filename -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*[.]exe$' -or $planValue.package.bytes -lt 1 -or $planValue.package.bytes -gt 536870912){throw 'Native package identity differs'}
$installer=Join-Path $inputDirectory $filename
Assert-DriverOwnerPath $planValue.package.path
if((Get-Item -LiteralPath $planValue.package.path).Length -ne $planValue.package.bytes -or
    (Get-FileHash -LiteralPath $planValue.package.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $planValue.package.sha256){throw 'Native original package differs before copy'}
Copy-Item -LiteralPath $planValue.package.path -Destination $installer -ErrorAction Stop
if((Get-Item -LiteralPath $installer).Length -ne $planValue.package.bytes -or
    (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $planValue.package.sha256){throw 'Native staged package differs'}
Assert-DriverOwnerPath $installer
$predecessorInstaller=$null
if($null -ne $planValue.predecessor) {
    $previous=$planValue.predecessor
    Assert-DriverOwnerPath $previous.path
    $previousName=[IO.Path]::GetFileName($previous.path)
    if($previousName -cnotmatch '^predecessor-[A-Za-z0-9][A-Za-z0-9._+-]*[.]exe$' -or $previous.bytes -lt 1 -or $previous.bytes -gt 536870912 -or
        (Get-Item -LiteralPath $previous.path).Length -ne $previous.bytes -or
        (Get-FileHash -LiteralPath $previous.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $previous.sha256) {throw 'Native predecessor original package differs'}
    $predecessorInstaller=Join-Path $inputDirectory $previousName
    Copy-Item -LiteralPath $previous.path -Destination $predecessorInstaller -ErrorAction Stop
    Assert-DriverOwnerPath $predecessorInstaller
    if((Get-Item -LiteralPath $predecessorInstaller).Length -ne $previous.bytes -or
        (Get-FileHash -LiteralPath $predecessorInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -cne $previous.sha256) {throw 'Native predecessor staged package differs'}
}
$derived=$boundary|Select-Object *;$derived.capture_root=$capture;$derived.work_root=$work
$derivedPath=Join-Path $capture 'bridge-configuration.json';Write-NewDriverJson $derivedPath $derived
$derivedSha=(Get-FileHash -LiteralPath $derivedPath -Algorithm SHA256).Hash.ToLowerInvariant()
$childEnvironment=[ordered]@{SystemRoot=$env:SystemRoot;WINDIR=$env:SystemRoot;
    PATH=(@([IO.Path]::GetDirectoryName($planValue.tools.git.path),[IO.Path]::GetDirectoryName($planValue.tools.desktop_tools.node.path),(Join-Path $env:SystemRoot 'System32')) -join ';');
    TEMP=$capture;TMP=$capture;USERPROFILE=[Environment]::GetFolderPath('UserProfile');
    GIT_CONFIG_NOSYSTEM='1';GIT_CONFIG_GLOBAL='NUL';GIT_TERMINAL_PROMPT='0';GIT_NO_LAZY_FETCH='1';GIT_OPTIONAL_LOCKS='0'}
$children=[Collections.Generic.List[object]]::new();$failure=$null;$session=$null;$finishAttempted=$false;$hostObservation=$null
$clock=[Diagnostics.Stopwatch]::StartNew();$started=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
try {
    $bridge=Start-DriverChild 'bridge' @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'native-qualification-account-bridge.ps1'),'-Configuration',$derivedPath,'-ExpectedConfigurationSha256',$derivedSha,'-InvocationId',$planValue.invocation_id)
    $children.Add($bridge)
    $statePath=Join-Path $capture 'bridge-state.json'
    while(-not [IO.File]::Exists($statePath)) {
        Save-DriverStreams $bridge
        if($bridge.process.HasExited -or $clock.Elapsed.TotalSeconds -ge 30){throw 'Native bridge startup incomplete'}
        Start-Sleep -Milliseconds 100
    }
    $state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
    if($state.phase -cne 'prepared' -or $state.broker_pid -ne $bridge.pid -or $state.broker_created_filetime -cne $bridge.created -or
        $state.invocation_id -cne $planValue.invocation_id -or $state.configuration_sha256 -cne $derivedSha){throw 'Native bridge prepared identity differs'}
    $binding=[ordered]@{invocation_id=$planValue.invocation_id;configuration_sha256=$derivedSha;helper_sha256=$boundary.helper_sha256;
        broker_pid=$bridge.pid;broker_created_filetime=$bridge.created;capture_root=$capture;account_sid=$boundary.account_sid;
        profile_root=$boundary.profile_root;work_root=$work;powershell=$planValue.tools.powershell;desktop_tools=$planValue.tools.desktop_tools;controller_root=$boundary.controller_root}
    $bindingPath=Join-Path $capture 'account-binding.json';Write-NewDriverJson $bindingPath $binding
    $bindingSha=(Get-FileHash -LiteralPath $bindingPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $session=Open-PortcoveNativeAccountSession $bindingPath $bindingSha
    $harnessArguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'test-windows-installer.ps1'),'-InstallerPath',$installer,'-TestBase',$work,'-EvidencePath',(Join-Path $capture 'installer.json'),'-ExpectedVersion',$planValue.version,'-NativeAccountBindingPath',$bindingPath,'-NativeAccountBindingSha256',$bindingSha,'-NativeParentOwnsFinish')
    if($publicMode) {
        $publicRemaining=[Math]::Floor(1750000-$clock.ElapsedMilliseconds)
        if($publicRemaining -lt 1) {throw 'Original public driver lifetime exhausted before installer'}
        $harnessArguments+=@('-OrdinaryPublicUpdateInputsPath',$planValue.public_inputs.path,'-OrdinaryPublicUpdateInputsSha256',$planValue.public_inputs.sha256,'-OrdinaryPublicUpdateRemainingMilliseconds',[string]$publicRemaining)
    }
    if($predecessorInstaller) {$harnessArguments+=@('-UpgradeFromInstallerPath',$predecessorInstaller,'-QualifyPackageRollback','-ExpectedPredecessorVersion',$planValue.predecessor.version)}
    $harness=Start-DriverChild 'harness' $harnessArguments
    $children.Add($harness)
    while(-not $harness.process.HasExited) {
        foreach($child in $children){Save-DriverStreams $child}
        if($bridge.process.HasExited -or $clock.Elapsed.TotalSeconds -ge 1750){throw 'Native stage deadline or bridge failure'}
        Start-Sleep -Milliseconds 100
    }
    if($harness.process.ExitCode -ne 0){throw 'Native installer harness refused; retain its raw result'}
    if(-not $publicMode){$hostObservation=Read-DriverHostObservation}
}catch{$failure=$_.Exception.Message}
finally {
    # The fixed parent owns the sole finish request in this mode. It is latched
    # before write; an ambiguous response is retained, never resent.
    if($session -and -not $finishAttempted){
        $finishAttempted=$true
        try{$null=Invoke-PortcoveNativeAccountCommand $session finish 'parent-stage-finish'}catch{$failure=([string]$failure+'; finish: '+$_.Exception.Message)}
    }
    foreach($child in $children){
        try {
            if(-not $child.process.WaitForExit(10000)){$child.process.Kill($true);$null=$child.process.WaitForExit(5000);throw 'Fixed native child did not settle; termination attempted once'}
            foreach($stream in @($child.stdout,$child.stderr)) {
                if(-not $stream.Completion.Wait(5000)){throw 'Native child stream completion remains ambiguous'}
                $stream.Completion.GetAwaiter().GetResult()|Out-Null
            }
        }catch{$failure=([string]$failure+'; child: '+$_.Exception.Message)}
        try{Save-DriverStreams $child}catch{$failure=([string]$failure+'; capture: '+$_.Exception.Message)}
    }
    try {
        Assert-DriverTool $planValue.tools.powershell (64MB);Assert-DriverTool $planValue.tools.git (128MB)
        foreach($tool in $planValue.tools.desktop_tools.PSObject.Properties.Value){Assert-DriverTool $tool (128MB)}
    }catch{$failure=([string]$failure+'; tool readback: '+$_.Exception.Message)}
    $result=[ordered]@{schema_version=1;invocation_id=$planValue.invocation_id;request_sha256=$planValue.request_sha256;
        started_at=$started;completed_at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');failure=$failure;finish_attempted=$finishAttempted;host_observation=$hostObservation;
        children=@($children|ForEach-Object{[ordered]@{role=$_.name;pid=$_.pid;created_filetime=$_.created;exited=$_.process.HasExited;exit_code=$(if($_.process.HasExited){$_.process.ExitCode}else{$null})}});
        authority='none';native_acceptance='not-established'}
    Write-NewDriverJson (Join-Path $capture 'driver-result.json') $result
    foreach($child in $children){$child.process.Dispose()}
}
if($failure){throw $failure}
