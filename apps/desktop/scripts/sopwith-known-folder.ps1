$ErrorActionPreference = 'Stop'
# SDL uses the shell known folder independently of APPDATA overrides. Observe
# only this fixed upstream subtree; never enumerate the account's whole profile.
$roaming = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
if ([string]::IsNullOrWhiteSpace($roaming)) { throw 'Windows Roaming AppData is unavailable.' }
$target = Join-Path $roaming 'SDL Sopwith'
$files = @()
if (Test-Path -LiteralPath $target) {
    if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked upstream known folder refused.' }
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($target)
    $count = 0
    $bytes = 0L
    while ($pending.Count) {
        $directory = $pending.Dequeue()
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            $count++
            if ($count -gt 2000 -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Upstream known-folder traversal bound or link refusal.' }
            if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
            else {
                $bytes += $entry.Length
                if ($bytes -gt 64MB) { throw 'Upstream known-folder byte bound exceeded.' }
                $files += [ordered]@{relative=[IO.Path]::GetRelativePath($target,$entry.FullName);bytes=$entry.Length;sha256=(Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
            }
        }
    }
}
[ordered]@{path=$target;exists=(Test-Path -LiteralPath $target);files=@($files|Sort-Object {$_.relative})}|ConvertTo-Json -Depth 5 -Compress
