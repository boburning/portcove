$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$inputs = Join-Path $env:RUNNER_TEMP 'corsix-exact-input'
New-Item -ItemType Directory -Path $inputs | Out-Null
$headers = @{Authorization="Bearer $env:GH_TOKEN"; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
$api = 'https://api.github.com/repos/boburning/portcove'
$artifact = Invoke-RestMethod -Headers $headers -Uri "$api/actions/artifacts/14175661476"
if ($artifact.id -ne 14175661476 -or $artifact.expired -or $artifact.workflow_run.id -ne 43741624423 -or $artifact.workflow_run.head_sha -ne $env:PORTCOVE_PRODUCT_SOURCE -or $artifact.digest -ne 'sha256:162614d148adc5c77504a54f1295560a8ba79da36dabf743a9e7e6d1989a824b') { throw 'Producer artifact identity differs' }
$zip = Join-Path $inputs 'producer.zip'
Invoke-WebRequest -Headers $headers -Uri "$api/actions/artifacts/14175661476/zip" -OutFile $zip
if ((Get-Item $zip).Length -ne 180498148 -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.digest.Substring(7)) { throw 'Producer artifact bytes differ' }
$env:PORTCOVE_CORSIX_INPUTS = $inputs
@'
import os,zipfile,json,hashlib
from pathlib import Path
p=Path(os.environ['PORTCOVE_CORSIX_INPUTS'])
with zipfile.ZipFile(p/'producer.zip') as z:
 assert set(z.namelist())=={'tests.tar.zst','manifest.json'}
 for i in z.infolist():
  assert (i.external_attr>>16)&0o170000!=0o120000 and i.file_size<1200000000
  with z.open(i) as src,(p/i.filename).open('xb') as dst:
   import shutil
   shutil.copyfileobj(src,dst)
m=json.loads((p/'manifest.json').read_text())
assert m['identity']['run']=='43741624423' and m['identity']['attempt']=='2'
with (p/'tests.tar.zst').open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==m['archive_sha256']
(p/'producer-summary.json').write_text(json.dumps({'identity':m['identity'],'archive_sha256':m['archive_sha256']}))
'@ | python -
$summary = Get-Content -Raw (Join-Path $inputs 'producer-summary.json') | ConvertFrom-Json
$commit = Invoke-RestMethod -Headers $headers -Uri "$api/git/commits/$($summary.identity.source)"
if ($env:PORTCOVE_PRODUCT_SOURCE -notin @($commit.parents.sha)) { throw 'Producer preview does not contain reviewed product head' }
$seven = 'C:\Program Files\7-Zip\7z.exe'
& $seven x -y "-o$inputs" (Join-Path $inputs 'tests.tar.zst') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Zstandard extraction failed' }
$cliDir = Join-Path $inputs 'cli'
& $seven e -y "-o$cliDir" (Join-Path $inputs 'tests.tar') 'target/debug/portcove.exe' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Ordinary CLI extraction failed' }
$cli = Join-Path $cliDir 'portcove.exe'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf) -or ((Get-Item $cli).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Ordinary CLI is not a regular file' }
$summary | Add-Member -NotePropertyName cli_sha256 -NotePropertyValue (Get-FileHash $cli -Algorithm SHA256).Hash.ToLowerInvariant()
$summary | Add-Member -NotePropertyName artifact_sha256 -NotePropertyValue $artifact.digest
$summary | ConvertTo-Json -Depth 8 | Set-Content evidence/producer.json -Encoding utf8
$cli | Set-Content input-cli.txt -Encoding utf8
