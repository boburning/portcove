# Slice 4 exact empty-account setup recovery — 2026-10-22

This is the narrow source-reconciled recovery for the already granted one-time setup. It is not a new runtime mechanism, account authority, credential grant or production activation. Controller `0bd69c01513da9d16c7a5acbcb73dc8a064255cd`, account helper `ef2f88896f33f49053c367aa1621234527b9ba1306681776287fb5d2ba532c10`, plan `67c28f511ddb23f6826d7025e8bc012727608b8b7d3df9beaab3b0e282e3467b` and protected reference remain unchanged. Do not replay the original launcher.

## Actual failure and retained scope

The owner supplied the actual child error from `C:/ProgramData/PortcoveSlice4Bootstrap/accounts.ps1:302`: **Setup password exceeds fixed credential bounds**. The condition is length less than 1 or greater than 256; it does not prove which case occurred and does not disclose the password. It executes before `New-LocalUser`. The outer **Retain original setup and use GET-only readback** message is the subsequent safety stop, not a second root cause.

Fresh GET-only readback verified the protected helper/plan hashes, exact matching original intent and complete local-user inventory with both fixed account names absent. The setup root contains exactly `intent.json` (470 bytes, SHA-256 `0358ba728d11d88b706ee73d206b989779c1da376a5eec18a6d3ee5c7c2a5c0f`), `account-0-intent.json` (135 bytes, SHA-256 `488d26c546b18fe005fbd5d94753f2520a9c9e514b0d1e9ce6a9dbb1a996ddf6`) and the zero-byte `setup.lock`. No owned SID, created-completion, credential-completion or enable receipt exists. Missing credential/profile evidence remains unknown; none is adopted.

## Exact recovery behavior

The [fixed helper](../../scripts/recover-local-worker-empty-setup.ps1), source `627982217b310ab1a0f86849ebe12e888b981856`, is 14,081 bytes, SHA-256 `45e08975488d20af7247241b1b55ef039a4874d3f49d54b238cf17efb7de2910`. It has no caller-selected paths, identities or policy. Execute requires the appointed same-owner SID and elevation. It refuses changed/missing raw records, altered SDDL, unsafe ancestry (including generic replacement rights), reparse/multiply-linked evidence, extra state, any existing recovery marker/archive/result, existing worker accounts/profile paths/registrations, an active account helper or unavailable process evidence.

The sole original root is `C:/ProgramData/PortcoveNativeQualification`. Its exact same-parent retained destination is `C:/ProgramData/PortcoveNativeQualification.retained-20261022-password-bounds`. No original record, folder or profile is deleted. After original-lock acquisition, exact-state and provider readback, the helper creates `empty-setup-recovery-20261022.json.lock` exclusively and writes the CreateNew recovery intent in the protected bootstrap folder. It rechecks the original state and hands off from the original lock to that separate recovery lock immediately before atomic same-volume rename. This lock serializes this recovery only. It does not claim that the old account helper participates in the new lock; a competing create cannot adopt an existing root because the unchanged helper atomically creates it. Any conflict, refusal or ambiguity stops and retains both states without retry.

After positive archived-byte/ACL/namespace and account/profile/process readback, the original protected helper and plan are held against replacement/write, rehashed, and invoked exactly once as the original `-Mode create` in a child `pwsh -NoProfile`. Passwords remain in its secure local input; no password is placed in arguments, environment, JSON, logs or chat. Native nonzero results are retained before the wrapper throws, even if the parent normally treats native exit codes as errors. Accounts remain disabled. Ordinary credential placement/readback and all remaining setup/custody/probe prerequisites still follow the consolidated ordering before final enable.

If archive, lock, intent, result or child state already exists, do not delete or rerun anything. Read back and reconcile the actual state. A failed response is not proof that no child effects occurred.

## Meaningful verification and retained failures

Separate nonwriting `reservation_review` cleared the recovery/handoff, source-bound input guards, four tests and actual Windows CI/security-inventory registration. Four actual Windows cases passed after the lock handoff repair: real temporary-directory rename and recovery-lock collision, changed/additional/hardlinked evidence refusal, a real inert failing child with retained exit/no replay, and account/profile/unavailable-process refusal. The profile case was subsequently corrected to use an exact raw Windows path and assert the specific profile error; its focused rerun passed (1 passed, zero skipped). None invokes account APIs for mutation or runs the recovery against ProgramData.

The original inert rename test failed: Windows denied parent-directory rename with the child lock open even with FileShare.Delete. The original expected-child-error fixture also returned the native failure status after assertions; its explicit completion marker was corrected without changing production failure handling. Both failures are retained. A later focused selection passed six cases but could not import `yaml` for the separate local CI-workflow contract; that is an incomplete local selection, not seven passes. Required current-head CI must qualify the installed dependency route before delivery.

The actual default non-elevated inspection held at unavailable command-line evidence for PowerShell PID `38076`, created `2026-10-22T13:07:07Z`, matching the original elevated-window timing. It performed no mutations and is not a successful execution preflight. The operator's elevated invocation must obtain positive evidence for every other relevant process; only its own current PID is excluded. No process is killed or assumed absent. Existing old VHD failures and all earlier evidence remain untouched.

## One operator action after delivery

Use the existing same-owner **elevated PowerShell 7** window. Prepare and retain two distinct valid account passwords locally. Paste the entire block below as one command. When each password prompt appears, type or paste only that account's password and press Enter. Input is hidden; do not submit an empty entry. Each entry must contain 1–256 characters and satisfy Windows policy. Save both passwords for the subsequent ordinary-broker credential stage. Do not send passwords here.

```powershell
& {
    $ErrorActionPreference = 'Stop'
    if ($PSVersionTable.PSEdition -cne 'Core' -or $PSVersionTable.PSVersion -lt [version]'7.4') { throw 'PowerShell 7.4+ required' }
    $taskRecoveryHandler = [Net.Http.HttpClientHandler]::new()
    $taskRecoveryHandler.AllowAutoRedirect = $false
    $taskRecoveryHandler.UseDefaultCredentials = $false
    $taskRecoveryClient = [Net.Http.HttpClient]::new($taskRecoveryHandler)
    $taskRecoveryClient.MaxResponseContentBufferSize = 65536
    $taskRecoveryDeadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(30))
    try {
        $taskRecoveryResponse = $taskRecoveryClient.GetAsync('https://raw.githubusercontent.com/boburning/portcove/627982217b310ab1a0f86849ebe12e888b981856/scripts/recover-local-worker-empty-setup.ps1', [Net.Http.HttpCompletionOption]::ResponseContentRead, $taskRecoveryDeadline.Token).GetAwaiter().GetResult()
        try {
            if ($taskRecoveryResponse.StatusCode -ne [Net.HttpStatusCode]::OK -or $taskRecoveryResponse.Content.Headers.ContentEncoding.Count -ne 0) { throw 'Reviewed recovery response differs' }
            $taskRecoveryBytes = $taskRecoveryResponse.Content.ReadAsByteArrayAsync($taskRecoveryDeadline.Token).GetAwaiter().GetResult()
            if ($taskRecoveryBytes.Length -ne 14081 -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskRecoveryBytes)).ToLowerInvariant() -cne '45e08975488d20af7247241b1b55ef039a4874d3f49d54b238cf17efb7de2910') { throw 'Reviewed recovery identity differs' }
            $taskRecoveryText = [Text.UTF8Encoding]::new($false, $true).GetString($taskRecoveryBytes)
        } finally { $taskRecoveryResponse.Dispose() }
    } finally { $taskRecoveryDeadline.Dispose(); $taskRecoveryClient.Dispose(); $taskRecoveryHandler.Dispose() }
    & ([scriptblock]::Create($taskRecoveryText)) -ExecuteApprovedArchiveAndCreate
}
```

Return the final JSON or the first child error if it stops. Keep the elevated window open for the already planned final-enable step. This is a one-time recovery/setup operation; it does not activate Tasks, Apps, signing, feeds or public execution. #254 stays Done; #315/#534/#246 remain pending; slice 5 is excluded.
