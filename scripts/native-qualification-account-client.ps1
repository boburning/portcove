param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$InvocationId,
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$BrokerPid,
    [Parameter(Mandatory)][ValidatePattern('^[0-9]+$')][string]$BrokerCreatedFileTime,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedHelperSha256,
    [Parameter(Mandatory)][ValidateLength(1,32768)][string]$RequestBase64
)
$ErrorActionPreference='Stop'
$helper=Join-Path $PSScriptRoot 'native-qualification-account.cs.txt'
if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedHelperSha256) { throw 'Fixed native client helper changed' }
Add-Type -TypeDefinition (Get-Content -LiteralPath $helper -Raw)
$bytes=[Convert]::FromBase64String($RequestBase64)
if ($bytes.Length -lt 2 -or $bytes.Length -gt 24000) { throw 'Native request exceeds fixed client bound' }
$text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
if ($text.Contains("`n") -or $text.Contains("`r")) { throw 'Native command must be one JSON line' }
$request=$text | ConvertFrom-Json
if ($request.invocation_id -cne $InvocationId) { throw 'Native client invocation mismatch' }
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.', 'PortcoveNative_' + $InvocationId,
    [IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
try {
    # Connection availability may fail. Once bytes are sent, every failure is
    # ambiguous and the caller must retain it and use state/readback, not resend.
    $pipe.Connect(5000)
    [Portcove.NativeQualification.OwnerCommandReader]::VerifyServer($pipe.SafePipeHandle.DangerousGetHandle(),[uint32]$BrokerPid,[long]$BrokerCreatedFileTime)
    $framed=[Text.UTF8Encoding]::new($false).GetBytes($text + "`n")
    $write=$pipe.WriteAsync($framed,0,$framed.Length)
    if (-not $write.Wait(5000)) { throw 'Ambiguous native command write timeout; no retry' }
    $write.GetAwaiter().GetResult()
    $reading=[Portcove.NativeQualification.OwnerCommandReader]::ReadResponse($pipe)
    if (-not $reading.Wait(15000)) { throw 'Ambiguous native command response timeout; no retry' }
    $responseText=$reading.GetAwaiter().GetResult()
    $response=$responseText | ConvertFrom-Json
    if ($response.schema_version -ne 1 -or $response.invocation_id -cne $InvocationId -or
        $response.sequence -ne $request.sequence -or $response.broker_pid -ne $BrokerPid) { throw 'Ambiguous native reply identity mismatch; no retry' }
    [Console]::Out.WriteLine($responseText)
} finally { $pipe.Dispose() }
