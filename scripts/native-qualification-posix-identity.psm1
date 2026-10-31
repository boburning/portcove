$ErrorActionPreference = "Stop"

# Read-only caller identity for ordinary rootless qualification. Import performs
# no observation; the maintained AppImage entrypoint owns when this runs.
function Get-RootlessQualificationIdentity {
    $userId = (& /usr/bin/id -u | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $userId -notmatch '^(0|[1-9]\d*)$') {
        throw "Could not determine the qualification user ID"
    }
    if ($userId -eq '0') { throw "Root cannot qualify ordinary rootless AppImage updates" }
    $groupId = (& /usr/bin/id -g | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $groupId -notmatch '^(0|[1-9]\d*)$') {
        throw "Could not determine the qualification group ID"
    }
    return [ordered]@{ uid = $userId; gid = $groupId }
}

Export-ModuleMember -Function Get-RootlessQualificationIdentity
