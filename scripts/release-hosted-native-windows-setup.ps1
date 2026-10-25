param([Parameter(Mandatory)][string]$ContextBase64)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest

function Read-HostedNativeSetupContext([string]$Encoded) {
    if($Encoded.Length -gt 8192){throw 'Hosted setup context exceeds bound'}
    $value=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String($Encoded))|ConvertFrom-Json
    if(($value.PSObject.Properties.Name|Sort-Object)-join ',' -cne 'binding,broker_created_ticks,broker_pid,run_attempt,run_id,schema_version,source_commit,source_tree' -or
        $value.schema_version -isnot [long] -or $value.schema_version -ne 1 -or $value.binding -cnotmatch '^[a-f0-9]{64}$' -or
        $value.source_commit -cnotmatch '^[a-f0-9]{40}$' -or $value.source_tree -cnotmatch '^[a-f0-9]{40}$' -or
        $value.run_id -cnotmatch '^[1-9][0-9]{0,19}$' -or $value.run_attempt -isnot [long] -or $value.run_attempt -ne 1 -or
        $value.broker_pid -isnot [long] -or $value.broker_pid -lt 1 -or $value.broker_pid -gt 4294967295 -or
        $value.broker_created_ticks -cnotmatch '^[1-9][0-9]{0,19}$'){throw 'Fixed hosted setup context differs'}
    return $value
}
function Write-HostedNativeSetupRecord([string]$Path,$Value) {
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 12 -Compress))
    if($bytes.Length -gt 65536){throw 'Hosted setup record exceeds bound'}
    $file=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try{$file.Write($bytes);$file.Flush($true)}finally{$file.Dispose()}
}
function Read-HostedNativeProbeStream($Stream) {
    $bytes=$Stream.Snapshot()
    return [ordered]@{bytes=$bytes.Length;prefix_base64=[Convert]::ToBase64String($bytes,0,[Math]::Min($bytes.Length,16384));truncated=($bytes.Length -gt 16384)}
}
function Assert-HostedNativeAccount($Expected,[bool]$Enabled) {
    $actual=Get-LocalUser -SID $Expected.SID -ErrorAction Stop
    if($actual.Name -cne 'PortcoveNativeQual' -or $actual.SID.Value -cne $Expected.SID.Value -or
        $actual.Description -cne $Expected.Description -or $actual.Enabled -ne $Enabled -or
        $actual.UserMayChangePassword -or $actual.PasswordExpires -or $actual.AccountExpires){throw 'Hosted account identity or policy differs'}
    $groups=@(Get-LocalGroup|ForEach-Object {
        $group=$_
        if(@(Get-LocalGroupMember -SID $group.SID -ErrorAction Stop|Where-Object {$_.SID.Value -ceq $Expected.SID.Value}).Count){$group.SID.Value}
    })
    if(($groups|Sort-Object)-join ',' -cne 'S-1-5-32-545'){throw 'Hosted candidate must have exactly ordinary Users membership'}
}

$context=Read-HostedNativeSetupContext $ContextBase64
$diagnosticRef=($env:GITHUB_EVENT_NAME -ceq 'pull_request' -and
    $env:GITHUB_WORKFLOW_REF -cmatch '^boburning/portcove/\.github/workflows/controller-tool-build-fixture\.yml@refs/pull/[1-9][0-9]*/merge$') -or
    ($env:GITHUB_EVENT_NAME -ceq 'push' -and $env:GITHUB_WORKFLOW_REF -ceq 'boburning/portcove/.github/workflows/controller-tool-build-fixture.yml@refs/heads/main')
if(-not $IsWindows -or $PSVersionTable.PSVersion.Major -ne 7 -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'boburning/portcove' -or
    $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or -not $diagnosticRef -or
    $env:GITHUB_RUN_ID -cne $context.run_id -or $env:GITHUB_RUN_ATTEMPT -cne '1'){
    throw 'Only the fixed credential-free hosted tool diagnostic may prepare this account'
}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not ([Security.Principal.WindowsPrincipal]::new($owner)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
    throw 'Hosted runner lacks required account-setup capability; no elevation or retry'
}
$clock=[Diagnostics.Stopwatch]::StartNew()
function Assert-OriginalHostedSetup {
    $parent=Get-Process -Id $context.broker_pid -ErrorAction Stop
    try{
        if($parent.HasExited -or (Get-CimInstance Win32_Process -Filter ('ProcessId = '+$context.broker_pid) -OperationTimeoutSec 5 -ErrorAction Stop).CreationDate.ToUniversalTime().Ticks.ToString() -cne $context.broker_created_ticks -or
            $clock.Elapsed.TotalSeconds -ge 60){throw 'Original hosted setup parent or lifetime unavailable'}
    }finally{$parent.Dispose()}
}
Assert-OriginalHostedSetup
$tools=Split-Path -Parent $PSScriptRoot
$manifest=Get-Content -LiteralPath (Join-Path $tools 'manifest.json') -Raw|ConvertFrom-Json
if($manifest.source_commit -cne $context.source_commit -or $manifest.source_tree -cne $context.source_tree -or
    $manifest.platform -cne 'windows-x86_64'){throw 'Original Windows tool source differs'}
$names=@('scripts/release-hosted-native-windows-setup.ps1','scripts/release-hosted-native-windows-setup.cs.txt',
    'scripts/native-qualification-account.cs.txt','scripts/native-qualification-account-registry.ps1','scripts/fixtures/native-account-gui-probe.ps1')
foreach($name in $names){
    $entry=@($manifest.files|Where-Object path -CEQ $name)
    $file=Join-Path $tools $name
    if($entry.Count -ne 1 -or (Get-Item -LiteralPath $file).Length -ne $entry[0].bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[0].sha256){throw 'Fixed hosted setup source changed'}
}
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-hosted-native-windows-setup.cs.txt') -Raw)
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'native-qualification-account.cs.txt') -Raw)
if($env:SystemRoot -ine [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) -or $env:SystemDrive -ine 'C:'){
    throw 'Fixed hosted Windows system paths differ'
}
$root='C:\ProgramData\PortcoveHostedNativeQualification'
$nativeProfile='C:\Users\PortcoveNativeQual'
if(@(Get-LocalUser|Where-Object Name -IEQ 'PortcoveNativeQual').Count -or (Test-Path -LiteralPath $nativeProfile) -or
    @(Get-CimInstance Win32_UserProfile -ErrorAction Stop|Where-Object {$_.LocalPath -ieq $nativeProfile}).Count){throw 'Existing hosted account/profile is retained; no adoption'}
Assert-OriginalHostedSetup
[Portcove.HostedNative.Setup]::Directory($root,$owner.User.Value,$null,$false)
Assert-OriginalHostedSetup
Write-HostedNativeSetupRecord (Join-Path $root 'intent.json') ([ordered]@{schema_version=1;context=$context;broker_sid=$owner.User.Value;account_name='PortcoveNativeQual';automatic_retry=$false;authority='none'})
$account=$null;$password=$null;$group=$null;$child=$null;$disabled=$false;$settled=$false;$failure=$null;$observation=$null
$actualProfile=$null;$registeredProfile=$null;$remaining=$null;$rootExited=$null
$cleanupFailures=[Collections.Generic.List[string]]::new()
$probeCapture=$null
try {
    Assert-OriginalHostedSetup
    $password=[Portcove.HostedNative.Setup]::Password()
    $description='PC534-hosted:'+$context.binding.Substring(0,32)
    $account=New-LocalUser -Name 'PortcoveNativeQual' -Password $password -Description $description -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Disabled
    Write-HostedNativeSetupRecord (Join-Path $root 'account-created.json') ([ordered]@{context=$context;sid=$account.SID.Value;name=$account.Name;description=$description;enabled=$false;credential='memory-only SecureString; never persisted';authority='none'})
    Add-LocalGroupMember -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')) -Member $account
    Assert-HostedNativeAccount $account $false
    Assert-OriginalHostedSetup
    $actualProfile=[Portcove.HostedNative.Setup]::Profile($account.SID.Value)
    if($actualProfile -ine $nativeProfile){throw 'Actual hosted profile differs; preserve registered partial state'}
    $registeredProfile=Get-ItemPropertyValue -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$account.SID.Value) -Name ProfileImagePath
    if([Environment]::ExpandEnvironmentVariables($registeredProfile) -ine $nativeProfile){throw 'Hosted profile registration differs'}
    $work=Join-Path $root 'work';$capture=Join-Path $root 'capture'
    [Portcove.HostedNative.Setup]::Directory($work,$owner.User.Value,$account.SID.Value,$true)
    $attemptWork=Join-Path $work $context.binding
    [Portcove.HostedNative.Setup]::Directory($attemptWork,$owner.User.Value,$account.SID.Value,$true)
    $roaming=Join-Path $attemptWork 'roaming';$local=Join-Path $attemptWork 'local'
    [Portcove.HostedNative.Setup]::Directory($roaming,$owner.User.Value,$account.SID.Value,$true)
    [Portcove.HostedNative.Setup]::Directory($local,$owner.User.Value,$account.SID.Value,$true)
    [Portcove.HostedNative.Setup]::Directory($capture,$owner.User.Value,$null,$false)
    # Grant traversal only on this fresh root, without inheritance into capture.
    $acl=Get-Acl -LiteralPath $root
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account.SID,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($root),$acl)
    $source=Join-Path $root 'controller';[Portcove.HostedNative.Setup]::Directory($source,$owner.User.Value,$account.SID.Value,$false)
    New-Item -ItemType Directory -Path (Join-Path $source 'scripts\fixtures')|Out-Null
    foreach($name in @('scripts/native-qualification-account-registry.ps1','scripts/fixtures/native-account-gui-probe.ps1')){
        Copy-Item -LiteralPath (Join-Path $tools $name) -Destination (Join-Path $source $name)
        if((Get-FileHash -LiteralPath (Join-Path $source $name)).Hash -cne (Get-FileHash -LiteralPath (Join-Path $tools $name)).Hash){throw 'Hosted inert source copy differs'}
    }
    $runtime=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $signature=Get-AuthenticodeSignature -LiteralPath $runtime
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)'){throw 'Fixed Windows PowerShell lacks valid Microsoft signature'}
    $runtimeSha=(Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant()
    $configuration=[Portcove.NativeQualification.AccountConfiguration]::new()
    $configuration.UserName=$account.Name;$configuration.AccountSid=$account.SID.Value;$configuration.BrokerSid=$owner.User.Value
    $configuration.ProfileRoot=$nativeProfile;$configuration.WorkRoot=$work;$configuration.PrivateDesktop='PortcoveNative_'+$context.binding.Substring(0,32)+'\Qualification'
    $environment=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($entry in @{SystemRoot=$env:SystemRoot;WINDIR=$env:SystemRoot;PATH=(Join-Path $env:SystemRoot 'System32');USERPROFILE=$nativeProfile;HOMEDRIVE=$env:SystemDrive;HOMEPATH='\Users\PortcoveNativeQual';APPDATA=$roaming;LOCALAPPDATA=$local;TEMP=$attemptWork;TMP=$attemptWork}.GetEnumerator()){$environment[$entry.Key]=$entry.Value}
    Assert-OriginalHostedSetup
    Enable-LocalUser -SID $account.SID
    Assert-HostedNativeAccount $account $true
    $group=[Portcove.NativeQualification.AccountLauncher]::CreateGroup($configuration)
    $arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $source 'scripts\fixtures\native-account-gui-probe.ps1'),'-Invocation',$context.binding)
    $child=[Portcove.NativeQualification.AccountLauncher]::StartVerifiedInGroup($group,$configuration,$password,$runtime,$runtimeSha,$arguments,$attemptWork,$environment,$false)
    $gui=$false
    while(-not $child.HasExited -and $clock.Elapsed.TotalSeconds -lt 55){
        Assert-OriginalHostedSetup
        $child.RefuseFaultedCapture()
        if($child.MainWindowHandle -ne [IntPtr]::Zero -and $child.Responding){$gui=$true;break}
        Start-Sleep -Milliseconds 100
    }
    if(-not $gui){throw 'Actual private-desktop inert GUI unavailable'}
    do {
        Assert-OriginalHostedSetup
        $child.RefuseFaultedCapture()
        $snapshot=$child.OutputCapture.Snapshot()
        if($snapshot.Length -gt 65536){throw 'Hosted inert output exceeds bound'}
        if($snapshot.Length -and $snapshot[$snapshot.Length-1] -eq 10){break}
        if($child.HasExited -or $clock.Elapsed.TotalSeconds -ge 55){throw 'Hosted inert stdout incomplete'}
        Start-Sleep -Milliseconds 25
    } while($true)
    if($snapshot.Length -gt 65536){throw 'Hosted inert output exceeds bound'}
    $observation=[Text.UTF8Encoding]::new($false,$true).GetString($snapshot)|ConvertFrom-Json
    if($observation.account_sid -cne $account.SID.Value -or $observation.pid -ne $child.Pid -or $observation.profile -ine $nativeProfile -or
        $observation.invocation -cne $context.binding -or $observation.registry.hive_present -ne $true -or $observation.registry.provenance -cne 'target-account-HKCU'){
        throw 'Actual isolated profile/HKCU observation differs'
    }
    $members=@($child.SnapshotOwnedJob())
    if(@($members|Where-Object Pid -EQ $observation.child_pid).Count -ne 1){throw 'Inert descendant absent from original job'}
    Write-HostedNativeSetupRecord (Join-Path $capture 'observed.json') ([ordered]@{context=$context;observation=$observation;root_pid=$child.Pid;root_created_filetime=$child.CreatedFileTime.ToString();members=$members;private_gui=$gui;runtime_sha256=$runtimeSha;authority='none'})
} catch {$failure=$_.Exception.Message;throw}
finally {
    try {
        if($group){
            $remaining=@($group.StopAndObserve(5000))
            if($child){$rootExited=$child.WaitForExit(5000)}
            if($remaining.Count -ne 0 -or ($child -and -not $rootExited)){throw 'Original hosted native job teardown incomplete'}
            $settled=$true
        }
    } catch {$cleanupFailures.Add($_.Exception.Message)}
    # Disabling the exact created identity is independent of process settlement.
    # It prevents further logons but never claims to terminate existing children.
    try {
        if($account){
            $current=Get-LocalUser -SID $account.SID
            if($current.Name -cne $account.Name -or $current.Description -cne $account.Description){throw 'Hosted cleanup account identity differs'}
            Disable-LocalUser -SID $account.SID
            $disabled= -not (Get-LocalUser -SID $account.SID).Enabled
            if(-not $disabled){throw 'Hosted account disable readback failed'}
        }
    } catch {$cleanupFailures.Add($_.Exception.Message)}
    finally {
        if($child){
            try {$probeCapture=@{stdout=(Read-HostedNativeProbeStream $child.OutputCapture);stderr=(Read-HostedNativeProbeStream $child.ErrorCapture);exit_code=$(if($rootExited){$child.ExitCode}else{$null})}}
            catch {$probeCapture=@{error=$_.Exception.Message}}
        }
        if($child){$child.Dispose()};if($group){$group.Dispose()};if($password){$password.Dispose()}
        if(-not $failure -and $cleanupFailures.Count){$failure='Hosted cleanup refused; retained details require recovery'}
        Write-HostedNativeSetupRecord (Join-Path $root 'result.json') ([ordered]@{schema_version=1;context=$context;account_sid=$(if($account){$account.SID.Value}else{$null});profile=$nativeProfile;actual_profile=$actualProfile;registered_profile=$registeredProfile;root_identity=$(if($child){@{pid=$child.Pid;created_filetime=$child.CreatedFileTime.ToString()}}else{$null});root_exited=$rootExited;remaining_pids=$remaining;disabled=$disabled;job_empty=$settled;failure=$failure;cleanup_failures=@($cleanupFailures.ToArray());probe_capture=$probeCapture;observed=$observation;automatic_retry=$false;authority='none';scope='inert hosted account/profile/private GUI/job primitive only; no package or native acceptance'})
    }
}
if(-not $disabled -or -not $settled -or $failure){throw 'Hosted inert account setup did not complete'}
Get-Content -LiteralPath (Join-Path $root 'result.json') -Raw
