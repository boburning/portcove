param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../../outputs/playnite'),
    [string]$SourceDirectory = (Join-Path $PSScriptRoot 'bin/Release')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$expected = @('extension.yaml', 'Portcove.Playnite.dll')
$actual = @(Get-ChildItem -LiteralPath $source -File | Select-Object -ExpandProperty Name)
if (@($actual | Where-Object { $_ -notin $expected }).Count -or
    @($expected | Where-Object { $_ -notin $actual }).Count) {
    throw "The Playnite package must contain exactly $($expected -join ', ')."
}
$manifest = Get-Content -LiteralPath (Join-Path $source 'extension.yaml') -Raw
$id = [regex]::Match($manifest, '(?m)^Id: ([0-9a-fA-F-]{36})\s*$').Groups[1].Value
$version = [regex]::Match($manifest, '(?m)^Version: ([0-9]+(?:\.[0-9]+){1,3})\s*$').Groups[1].Value
if (!$id -or !$version -or $manifest -notmatch '(?m)^Module: Portcove\.Playnite\.dll\s*$' -or
    $manifest -notmatch '(?m)^Type: GameLibrary\s*$') {
    throw 'Playnite extension.yaml does not identify the expected library plugin.'
}

$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$name = "{0}_{1}.pext" -f $id, $version.Replace('.', '_')
$package = Join-Path $destination $name
$stream = [IO.File]::Open($package, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($entry in $expected) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, (Join-Path $source $entry), $entry, [IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }

$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    $entries = @($archive.Entries | Select-Object -ExpandProperty FullName)
    if ($entries.Count -ne $expected.Count -or @($entries | Where-Object { $_ -notin $expected }).Count) {
        throw 'Playnite package entries changed during creation.'
    }
} finally { $archive.Dispose() }
Write-Output $package
