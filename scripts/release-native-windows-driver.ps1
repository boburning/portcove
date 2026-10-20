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

$planValue=Read-DriverJson $Plan $ExpectedPlanSha256
if($planValue.schema_version -ne 1 -or $planValue.invocation_id -cnotmatch '^[a-f0-9]{64}$' -or
    $planValue.request_sha256 -cnotmatch '^[a-f0-9]{64}$' -or $planValue.stage -cne 'payload-signing') {throw 'Native driver plan differs'}
$boundary=Read-DriverJson $planValue.boundary.path $planValue.boundary.sha256
$capture=Join-Path $boundary.capture_root ('native-attempt-'+$planValue.invocation_id)
if([IO.Path]::GetFullPath($Plan) -cne (Join-Path $capture 'windows-plan.json') -or
    [IO.Path]::GetFullPath($PSScriptRoot) -cne (Join-Path $boundary.controller_root 'scripts')) {throw 'Native driver is outside the fixed parent/capture'}
Assert-DriverOwnerPath $capture
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
$derived=$boundary|Select-Object *;$derived.capture_root=$capture;$derived.work_root=$work
$derivedPath=Join-Path $capture 'bridge-configuration.json';Write-NewDriverJson $derivedPath $derived
$derivedSha=(Get-FileHash -LiteralPath $derivedPath -Algorithm SHA256).Hash.ToLowerInvariant()
$childEnvironment=[ordered]@{SystemRoot=$env:SystemRoot;WINDIR=$env:SystemRoot;
    PATH=(@([IO.Path]::GetDirectoryName($planValue.tools.git.path),[IO.Path]::GetDirectoryName($planValue.tools.desktop_tools.node.path),(Join-Path $env:SystemRoot 'System32')) -join ';');
    TEMP=$capture;TMP=$capture;USERPROFILE=[Environment]::GetFolderPath('UserProfile');
    GIT_CONFIG_NOSYSTEM='1';GIT_CONFIG_GLOBAL='NUL';GIT_TERMINAL_PROMPT='0';GIT_NO_LAZY_FETCH='1';GIT_OPTIONAL_LOCKS='0'}
$children=[Collections.Generic.List[object]]::new();$failure=$null;$session=$null;$finishAttempted=$false
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
    $harness=Start-DriverChild 'harness' @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'test-windows-installer.ps1'),'-InstallerPath',$installer,'-TestBase',$work,'-EvidencePath',(Join-Path $capture 'installer.json'),'-ExpectedVersion',$planValue.version,'-NativeAccountBindingPath',$bindingPath,'-NativeAccountBindingSha256',$bindingSha,'-NativeParentOwnsFinish')
    $children.Add($harness)
    while(-not $harness.process.HasExited) {
        foreach($child in $children){Save-DriverStreams $child}
        if($bridge.process.HasExited -or $clock.Elapsed.TotalSeconds -ge 1750){throw 'Native stage deadline or bridge failure'}
        Start-Sleep -Milliseconds 100
    }
    if($harness.process.ExitCode -ne 0){throw 'Native installer harness refused; retain its raw result'}
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
        started_at=$started;completed_at=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');failure=$failure;finish_attempted=$finishAttempted;
        children=@($children|ForEach-Object{[ordered]@{role=$_.name;pid=$_.pid;created_filetime=$_.created;exited=$_.process.HasExited;exit_code=$(if($_.process.HasExited){$_.process.ExitCode}else{$null})}});
        authority='none';native_acceptance='not-established'}
    Write-NewDriverJson (Join-Path $capture 'driver-result.json') $result
    foreach($child in $children){$child.process.Dispose()}
}
if($failure){throw $failure}
