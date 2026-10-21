param(
    [Parameter(Mandatory)][ValidatePattern('^\\[A-Za-z0-9_\\-]{1,180}$')][string]$TaskPath,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$ParentProcessId,
    [Parameter(Mandatory)][ValidateLength(1,12000)][string]$ProtectedPathsBase64
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Assert-OwnerPath([string]$Path, [bool]$Directory, [bool]$Protected, [bool]$Private = $false) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $Directory) { throw 'Native custody path kind/reparse point differs' }
    $acl = Get-Acl -LiteralPath $Path
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner) { throw 'Native custody path owner differs' }
    if ($Protected -and -not $acl.AreAccessRulesProtected) { throw 'Native custody directory inheritance is not protected' }
    $write = [Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($Private -and $rule.AccessControlType -eq 'Allow' -and
            $rule.IdentityReference.Value -notin @($owner,'S-1-5-18','S-1-5-32-544')) { throw 'Native credential custody permits a foreign reader' }
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and
            $rule.IdentityReference.Value -notin @($owner,'S-1-5-18','S-1-5-32-544')) { throw 'Native custody path writable by another identity' }
    }
    $ancestor = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    $ancestorWrite = [Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    $depth = 0
    while ($ancestor) {
        if (++$depth -gt 64) { throw 'Native custody ancestry exceeds bound' }
        $entry = Get-Item -LiteralPath $ancestor -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native custody ancestor is a reparse point' }
        foreach ($rule in (Get-Acl -LiteralPath $ancestor).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
                $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $ancestorWrite) -and
                $rule.IdentityReference.Value -notin @($owner,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'Native custody ancestor permits foreign replacement' }
        }
        $parent = [IO.Path]::GetDirectoryName($ancestor)
        if (-not $parent -or $parent -eq $ancestor) { break }
        $ancestor = $parent
    }
    return [ordered]@{path=$Path; directory=$Directory; owner_sid=$owner; protected=$acl.AreAccessRulesProtected; private=$Private}
}

$pathsBytes = [Convert]::FromBase64String($ProtectedPathsBase64)
if ($pathsBytes.Length -gt 8192) { throw 'Native custody path inventory exceeds bound' }
$paths = [Text.UTF8Encoding]::new($false,$true).GetString($pathsBytes) | ConvertFrom-Json
$expectedPathNames=@('authorities','boundary','capture','controller','descriptor','installation','native_issuer','source_reader','source_tool')
if($paths.PSObject.Properties.Name -ccontains 'public_boundary'){$expectedPathNames+=@('public_boundary')}
if ((@($paths.PSObject.Properties.Name | Sort-Object) -join ',') -cne (($expectedPathNames|Sort-Object)-join ',')) { throw 'Native custody path inventory differs' }
$custody = [ordered]@{}
foreach ($name in $expectedPathNames) {
    $isDirectory = $name -in @('capture','controller')
    $custody[$name] = Assert-OwnerPath ([string]$paths.$name) $isDirectory $isDirectory ($name -in @('native_issuer','source_reader'))
}
Assert-OwnerPath $PSCommandPath $false $false | Out-Null
if (-not [string]::Equals([IO.Path]::GetFullPath((Join-Path $paths.controller 'scripts')),[IO.Path]::GetFullPath($PSScriptRoot),[StringComparison]::OrdinalIgnoreCase)) { throw 'Native reader is outside protected controller staging' }

function Read-PublicAccountRoot([string]$Path,[string]$AccountSid) {
    $full=[IO.Path]::GetFullPath($Path)
    $item=Get-Item -LiteralPath $full -Force
    $acl=Get-Acl -LiteralPath $full
    $broker=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed=@($broker,$AccountSid,'S-1-5-18','S-1-5-32-544')
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $acl.AreAccessRulesProtected -or $owner -notin @($broker,$AccountSid)){throw 'Public account directory kind/owner/protection differs'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){throw 'Public account directory accessible by another identity'}
    }
    $cursor=[IO.Path]::GetDirectoryName($full);$depth=0
    $replace=[Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
    while($cursor){
        if(++$depth -gt 64){throw 'Public root ancestry exceeds bound'}
        $ancestor=Get-Item -LiteralPath $cursor -Force
        if($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Public account root ancestry aliased'}
        foreach($rule in (Get-Acl -LiteralPath $cursor).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
            if(($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $replace) -and $rule.IdentityReference.Value -notin ($allowed+@('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'))){throw 'Public account root ancestor permits foreign replacement'}
        }
        $next=[IO.Path]::GetDirectoryName($cursor);if(-not $next -or $next -eq $cursor){break};$cursor=$next
    }
    [ordered]@{path=$Path;owner_sid=$owner;protected=$acl.AreAccessRulesProtected;isolated=$true}
}
$publicAccountObservation=$null
if($paths.PSObject.Properties.Name -ccontains 'public_boundary'){
    $public=Get-Content -LiteralPath $paths.public_boundary -Raw|ConvertFrom-Json
    if($public.schema_version -ne 2 -or $public.purpose -cne 'ordinary-public-proof' -or $public.broker_sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Public boundary purpose/broker differs'}
    $user=Get-LocalUser -Name ([string]$public.account_name) -ErrorAction Stop
    if($user.SID.Value -cne $public.account_sid -or -not $user.Enabled){throw 'Appointed local public account differs'}
    $profileKey='Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$public.account_sid
    $registered=[Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath)
    if(-not [string]::Equals([IO.Path]::GetFullPath($registered),[IO.Path]::GetFullPath($public.profile_root),[StringComparison]::OrdinalIgnoreCase)){throw 'Public profile registration differs'}
    $publicAccountObservation=[ordered]@{account_name=[string]$user.Name;account_sid=[string]$user.SID.Value;enabled=[bool]$user.Enabled;profile_registered=$true;
        hku_loaded=[bool](Test-Path -LiteralPath ('Registry::HKEY_USERS\'+$public.account_sid));
        profile=(Read-PublicAccountRoot ([string]$public.profile_root) ([string]$public.account_sid));work=(Read-PublicAccountRoot ([string]$public.work_root) ([string]$public.account_sid))}
}

function Read-ProcessIdentity([int]$ProcessIdentity) {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessIdentity")
    if ($rows.Count -ne 1) { throw 'Scheduler process identity absent or repeated' }
    $row = $rows[0]
    $process = [Diagnostics.Process]::GetProcessById($ProcessIdentity)
    try {
        $created = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
        $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
        if ($owner.ReturnValue -ne 0 -or [string]::IsNullOrEmpty($owner.Sid) -or
            [string]::IsNullOrEmpty($row.ExecutablePath) -or [string]::IsNullOrEmpty($row.CommandLine)) {
            throw 'Scheduler process executable/owner/command readback unavailable'
        }
        $after = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessIdentity")
        if ($after.Count -ne 1 -or $after[0].ParentProcessId -ne $row.ParentProcessId -or
            $after[0].CreationDate -ne $row.CreationDate -or
            $process.HasExited -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -cne $created) {
            throw 'Scheduler process changed during readback'
        }
        return [ordered]@{pid=$ProcessIdentity; parent_pid=[int]$row.ParentProcessId; created_filetime=$created;
            image=[string]$row.ExecutablePath; command_line=[string]$row.CommandLine; owner_sid=[string]$owner.Sid}
    } finally { $process.Dispose() }
}

function Read-TaskState($RegisteredTask) {
    $xml = [string]$RegisteredTask.Xml
    if ([Text.Encoding]::UTF8.GetByteCount($xml) -gt 65536) { throw 'Scheduler XML exceeds bound' }
    $definition = $RegisteredTask.Definition
    $actions = @($definition.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Type -ne 0) { throw 'Native scheduler requires one fixed Exec action' }
    $instances = @($RegisteredTask.GetInstances(0))
    if ($instances.Count -ne 1) { throw 'Native scheduler requires one visible running instance' }
    $instance = $instances[0]
    $instance.Refresh()
    $sddl = [string]$RegisteredTask.GetSecurityDescriptor(7)
    if ([Text.Encoding]::UTF8.GetByteCount($sddl) -gt 16384) { throw 'Native task security descriptor exceeds bound' }
    $security = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($security.Owner.Value -cne $ownerSid -or $null -eq $security.DiscretionaryAcl) { throw 'Native task owner or DACL differs' }
    $readExecute = [Convert]::ToInt64('A01200A9',16)
    foreach ($ace in $security.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'Native task has an unsupported access-control entry' }
        if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
            $ace.SecurityIdentifier.Value -notin @($ownerSid,'S-1-5-18','S-1-5-32-544') -and
            (([long]$ace.AccessMask -band 0xffffffffL) -band (-bnot $readExecute))) { throw 'Native task is writable by a foreign identity' }
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $xmlHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml))).Replace('-','').ToLowerInvariant()
        $securityHash = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($sddl))).Replace('-','').ToLowerInvariant()
    }
    finally { $hash.Dispose() }
    return [ordered]@{path=[string]$RegisteredTask.Path; xml_sha256=$xmlHash; security_descriptor_sha256=$securityHash; security_owner_sid=$ownerSid;
        enabled=[bool]$RegisteredTask.Enabled; state=[int]$RegisteredTask.State;
        principal=[ordered]@{user_id=[string]$definition.Principal.UserId; logon_type=[int]$definition.Principal.LogonType; run_level=[int]$definition.Principal.RunLevel};
        action=[ordered]@{path=[string]$actions[0].Path; arguments=[string]$actions[0].Arguments; working_directory=[string]$actions[0].WorkingDirectory};
        settings=[ordered]@{multiple_instances=[int]$definition.Settings.MultipleInstances; execution_time_limit=[string]$definition.Settings.ExecutionTimeLimit};
        instance=[ordered]@{guid=[string]$instance.InstanceGuid; engine_pid=[int]$instance.EnginePID; state=[int]$instance.State; current_action=[string]$instance.CurrentAction}}
}

# Read-only COM and process queries only. Never register, run, stop or alter a task.
$self = Read-ProcessIdentity $PID
if ($self.parent_pid -ne $ParentProcessId) { throw 'Native scheduler reader has another direct parent' }
$parent = Read-ProcessIdentity $ParentProcessId
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$task = $service.GetFolder('\').GetTask($TaskPath)
$before = Read-TaskState $task
$chain = [Collections.Generic.List[object]]::new()
$current = $parent
$seen = [Collections.Generic.HashSet[int]]::new()
for ($index = 0; $index -lt 16; $index++) {
    if (-not $seen.Add([int]$current.pid)) { throw 'Scheduler process ancestry cycles' }
    $chain.Add($current)
    if ($current.pid -eq $before.instance.engine_pid) { break }
    if ($current.parent_pid -lt 1) { throw 'Native parent is not an observed scheduler-engine descendant' }
    $next = Read-ProcessIdentity $current.parent_pid
    if ([decimal]$next.created_filetime -gt [decimal]$current.created_filetime) { throw 'Scheduler ancestor was replaced' }
    $current = $next
}
if ($chain[$chain.Count - 1].pid -ne $before.instance.engine_pid) { throw 'Scheduler ancestry exceeds bound' }
$after = Read-TaskState $task
if (($before | ConvertTo-Json -Depth 8 -Compress) -cne ($after | ConvertTo-Json -Depth 8 -Compress)) {
    throw 'Native scheduler task or instance changed during readback'
}
$finalParent = Read-ProcessIdentity $ParentProcessId
if (($parent | ConvertTo-Json -Compress) -cne ($finalParent | ConvertTo-Json -Compress)) {
    throw 'Native parent changed during scheduler readback'
}
$result=[ordered]@{schema_version=1; task=$before; reader=$self; chain=@($chain.ToArray()); custody=$custody;
    current_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    observed_at=[DateTime]::UtcNow.ToString('o')}
if($null -ne $publicAccountObservation){$result['public_account']=$publicAccountObservation}
$result | ConvertTo-Json -Depth 10 -Compress
