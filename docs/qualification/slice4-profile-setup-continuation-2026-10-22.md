# Slice 4 retained disabled-account setup continuation — 2026-10-22

Owner: [#534](https://github.com/boburning/portcove/issues/534). This implements the owner's instruction to fix setup and resume the existing disabled account with minimal manual participation. It reconciles executable setup source within the existing consolidated grant. It grants no production activation, signing, publication or additional account authority. The runnable production controller remains `0bd69c01513da9d16c7a5acbcb73dc8a064255cd` and the protected reference remains `refs/tags/portcove-production-controller-slice4-20261021r1`.

## Actual retained state

The [empty-attempt recovery](slice4-empty-account-setup-recovery-2026-10-22.md) ran once and retained the first attempt under `C:/ProgramData/PortcoveNativeQualification.retained-20261022-password-bounds`. Its child progressed past password input, created `PortcoveNativeQual` as disabled and recorded SID `S-1-5-21-1007133822-4277289207-646028416-1008`. The recorded ordinary Users membership exists. The actual next failure was `Profile`: **The stub received bad data. (0x800706F7)**. The recovery result retains child exit 1 and no automatic retry.

Fresh GET-only SAM, group, complete profile-registration and fixed-path readback found that exact first account disabled, no first profile, and no second account or profile. The root contains exactly five JSON records and its zero-byte original lock. The [continuation helper](../../scripts/resume-local-worker-profile.ps1) binds every original record's exact length/hash and the actual recorded SID, description, account policy and Users-only membership; it rejects changed state, additional effects, existing or suffixed profile registrations, case variants of an existing second account, reparse/hardlinked evidence, unavailable provider data and an active original setup lock.

Do not repeat either original launcher, reset a password, recreate the first account, or remove a record. Both original attempts and old VHD evidence remain retained.

## Reviewed continuation and source identity

The companion source is `53f7e306aeb66fbb91b46f21014a35060769c515`, 23,678 bytes, SHA-256 `6191a43704ec7f02d163fee2b6651e75aff39f90e79d3e01bb1a419d2fc1eccd`. Complete runs only from `C:/ProgramData/PortcoveSlice4Bootstrap/profile-resume.ps1`, under the same appointed broker and elevation. The command below installs those authenticated immutable bytes privately and atomically, verifies their hash, ownership, ACL and single-link identity, and holds them against writes/deletion through the child. A matching installed source may be read and reused; differing or partial bytes are retained and refused, never overwritten.

The original protected `accounts.ps1` remains unchanged at SHA-256 `ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10` (33,482 bytes). The original 149-byte plan remains `67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b`. The companion holds both files against changes and extracts exact, closed AST boundaries from the verified template. It holds the original exclusive setup lock, revalidates the initial six-file namespace and provider state, and creates a new durable continuation intent before profile or account effects.

Only the first account's post-group profile/work/record suffix is resumed. Its SID, password and completed group addition are untouched. The second account uses the original complete loop body, including one hidden password prompt, disabled creation and SID/group journals. The original final directory/ACL/provider checks and completion tail run for both ordered accounts. The narrow executable amendments are:

- A 260-character profile buffer for these fixed short paths, replacing 32,768. [Microsoft's CreateProfile contract](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createprofile) documents character-count sizing and administrative privilege, but does not state a maximum. This targeted repair still requires the actual elevated successful profile observation; the non-elevated invalid-SID differential returned `0x80070522` for both sizes and cannot prove it.
- The same constructed DirectorySecurity is persisted through `FileSystemAclExtensions.SetAccessControl`, without requesting a privilege change. A real temporary-directory run of the old PowerShell Set-Acl route failed with SeSecurityPrivilege at the final parent permission update; the managed persistence route completed the same actual permission journey.
- ACL identity comparison clears only `SE_DACL_AUTO_INHERITED` bookkeeping. A separate real temporary-directory observation showed requested `D:P` and returned `D:PAI` with identical owner and ACEs. Protection, owner, every permission entry and all other flags remain compared. Full observed SDDL is retained in completion postimages.
- The original closed-key validator also handles in-memory IDictionary records, which the original loop passes to Assert-Account before JSON serialization. Deserialized objects and duplicate-JSON-name refusal keep their existing semantics.

`created.json.source_sha256` explicitly identifies the **original template**, not an assertion that EF bytes alone executed. Its closed `continuation` field binds the actual companion hash, original template/intent, owned SID and buffer size. The separate private continuation intent retains all five exact prefix preimages; they are rehashed again after the loop and before writing completion. `profile-resume-complete-20261022.json` binds the actual companion, intent raw hash and final created.json raw hash. Complete and mandatory Readback verify the composite, prefix bytes, both disabled account identities, registered profiles and all actual ACL postimages.

Run this composite readback before the unchanged ordinary-broker credentials stage or the later original final-enable stage. The latter's existing explicit created.json hash covers the continuation field. Do not treat the old template hash alone as the whole execution identity. The original account helper remains the credentials/enable consumer; its inputs stay compatible.

## Verification and limits

The full source-bound account suite passed locally: **17 tests, 17 passed, zero skipped**, including five new Windows continuation cases. They execute the actual extracted suffix, second-account loop, complete tail and original credential/enable AST. SAM, Profile, Credential Manager and Enable providers are controlled. Temporary directories use actual Windows permission writes/readback, file locks, hardlink identity reads and raw JSON hashing; outer fixture ancestor metadata is controlled. No real account, profile, credential or activation result is credited from those fixtures.

The cases cover one second-account-only prompt/create and no first-account replay, exact account ordering, private/cross-account directory permissions, actual composite prefix/source refusals, original credential/enable compatibility, wrong receipt hashes, activation replay refusal, partial credential-write intent retention/no retry, and changed/missing/enabled/extra/case-variant/provider/group/profile refusals. The source installer uses actual private atomic creation, immutable read holding and a real inert child reading the held script; it refuses changed retained bytes, foreign writers and oversized source without overwriting evidence. Selected PSScriptAnalyzer 1.25.0 passed under the maintained rules. Required final-head hosted CI and independent review remain delivery gates; their exact identities are retained in the owning issue/PR receipt.

Retain earlier fixture failures separately: incorrect literal-AST extraction, fixture escaping and variable-shadowing errors, inherited foreign access in the temporary parent, the old actual ACL bookkeeping/provider failures and the in-memory key mismatch. The initial non-elevated invalid-input probe also had two AST extraction failures before obtaining its actual privilege-denied observations. No retry of a real setup/profile operation occurred during preparation. An earlier GET-only Inspect passed against the retained snapshot. A later final-source Inspect was refused by resource admission because the repository changed while queued; it did not execute and is retained separately. Final frozen-source Inspect, including C:/Users ancestry, must pass before operator handoff; successful preflight establishes eligibility only.

## One operator command after delivery

Use the existing same-owner elevated PowerShell 7 window. Keep the saved first-account password. Only the new `PortcovePublicProof` password is requested here; prepare and save it locally for the later ordinary-broker credential step. Password input stays hidden, nonempty, at most 256 characters and subject to Windows policy. Do not send it through chat.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    $PSNativeCommandUseErrorActionPreference = $false
    if ($PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.4') { throw 'PowerShell 7.4+ required' }
    $taskBroker = 'S-1-5-21-1007133822-4277289207-646028416-1001'
    $taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($taskIdentity.User.Value -cne $taskBroker -or -not ([Security.Principal.WindowsPrincipal]::new($taskIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use the existing same-owner Administrator PowerShell window' }
    $taskHandler = [Net.Http.HttpClientHandler]::new()
    $taskHandler.AllowAutoRedirect = $false
    $taskHandler.UseDefaultCredentials = $false
    $taskClient = [Net.Http.HttpClient]::new($taskHandler)
    $taskClient.MaxResponseContentBufferSize = 65536
    $taskDeadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
    try {
        $taskResponse = $taskClient.GetAsync('https://raw.githubusercontent.com/boburning/portcove/53f7e306aeb66fbb91b46f21014a35060769c515/scripts/resume-local-worker-profile.ps1', [Net.Http.HttpCompletionOption]::ResponseContentRead, $taskDeadline.Token).GetAwaiter().GetResult()
        try {
            if ($taskResponse.StatusCode -ne [Net.HttpStatusCode]::OK -or $taskResponse.Content.Headers.ContentEncoding.Count -ne 0) { throw 'Reviewed continuation response differs' }
            $taskBytes = $taskResponse.Content.ReadAsByteArrayAsync($taskDeadline.Token).GetAwaiter().GetResult()
            $taskSha = '6191a43704ec7f02d163fee2b6651e75aff39f90e79d3e01bb1a419d2fc1eccd'
            if ($taskBytes.Length -ne 23678 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskBytes)).ToLowerInvariant() -cne $taskSha) { throw 'Reviewed continuation bytes differ' }
            $taskText = [Text.UTF8Encoding]::new($false, $true).GetString($taskBytes)
        } finally { $taskResponse.Dispose() }
    } finally { $taskDeadline.Dispose(); $taskClient.Dispose(); $taskHandler.Dispose() }
    $taskTokens = $null; $taskErrors = $null
    $taskTree = [Management.Automation.Language.Parser]::ParseInput($taskText, [ref]$taskTokens, [ref]$taskErrors)
    if ($taskErrors.Count) { throw 'Reviewed continuation parse failed' }
    foreach ($taskName in @('Assert-RecoveryDirectory', 'Read-RecoveryFile', 'Get-SetupAclIdentity', 'Open-ProfileResumeSource')) {
        $taskFunctions = @($taskTree.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $taskName }, $true))
        if ($taskFunctions.Count -ne 1) { throw 'Reviewed installer function inventory differs' }
        . ([scriptblock]::Create($taskFunctions[0].Extent.Text))
    }
    $taskNative = @($taskTree.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type' -and $n.CommandElements.Count -eq 2 -and $n.CommandElements[1] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true))
    if ($taskNative.Count -ne 1) { throw 'Reviewed file-identity helper inventory differs' }
    . ([scriptblock]::Create($taskNative[0].Extent.Text))
    $null = Read-RecoveryFile 'C:\ProgramData\PortcoveSlice4Bootstrap\accounts.ps1' 'ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10' 33482
    $null = Read-RecoveryFile 'C:\ProgramData\PortcoveSlice4Bootstrap\accounts.json' '67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b' 149
    $taskHeldSource = Open-ProfileResumeSource $taskBytes $taskSha $taskBroker
    try {
        & "$PSHOME\pwsh.exe" -NoProfile -File 'C:\ProgramData\PortcoveSlice4Bootstrap\profile-resume.ps1' -Operation Complete
        $taskChildExit = $LASTEXITCODE
        if ($taskChildExit -ne 0) { throw 'Continuation stopped. Preserve the first child error and all records; do not rerun.' }
    } finally { $taskHeldSource.Dispose() }
}
```

Return the final JSON or the first child error. Successful completion leaves both accounts disabled, credentials uninstalled and production held. The owner then needs no new account-creation attempt. The ordinary broker's existing credentials stage and the later final-enable command remain subject to the consolidated ordering and actual remaining source/configuration/Task/WSL/custody observations.

On refusal or ambiguity, the new intent and any completed profile/account/group/ACL effects remain retained. Do not repeat Complete or source installation against differing bytes. Use the original protected account helper's GET-only `-Mode readback` to identify the actual phase. The original recorded-SID disable recovery remains available for applicable owned accounts; it does not delete profiles, reset passwords, restore ACLs, or prove process closure. Prepare any matching action from actual readback rather than guessing that a failed call had no effect.

#254 stays Done; #315/#534/#246 acceptance remains pending. Existing Chameleon artifact acceptance and its remaining runtime/custody evidence retain their actual scopes. D1/D2/D3, bounded-attempt capacity with Unknown availability/headroom and no reservation, $0 stop-usage/resource restrictions, production holds and slice 5 exclusion remain unchanged.
