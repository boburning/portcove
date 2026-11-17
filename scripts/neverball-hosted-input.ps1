$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$inputs = Join-Path $env:RUNNER_TEMP 'neverball-exact-input'
New-Item -ItemType Directory -Path $inputs | Out-Null
$headers = @{Authorization="Bearer $env:GH_TOKEN"; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
$api = 'https://api.github.com/repos/boburning/portcove'
$artifact = Invoke-RestMethod -Headers $headers -Uri "$api/actions/artifacts/14347807526"
if ($artifact.id -ne 14347807526 -or $artifact.expired -or $artifact.workflow_run.id -ne 44121160900 -or $artifact.workflow_run.head_sha -ne $env:PORTCOVE_PRODUCT_SOURCE -or $artifact.digest -ne 'sha256:fd02092b035eea76d6e0d6857695335a9a2c1c6a9cc695d3ad92dc01b0932afe') { throw 'Producer artifact identity differs' }
$zip = Join-Path $inputs 'producer.zip'
Invoke-WebRequest -Headers $headers -Uri "$api/actions/artifacts/14347807526/zip" -OutFile $zip
if ((Get-Item $zip).Length -ne 185051047 -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.digest.Substring(7)) { throw 'Producer artifact bytes differ' }
$env:PORTCOVE_STREET_INPUTS = $inputs
@'
import os,zipfile,json,hashlib
from pathlib import Path
p=Path(os.environ['PORTCOVE_STREET_INPUTS'])
with zipfile.ZipFile(p/'producer.zip') as z:
 assert set(z.namelist())=={'tests.tar.zst','manifest.json'}
 for i in z.infolist():
  assert (i.external_attr>>16)&0o170000!=0o120000 and i.file_size<1200000000
  with z.open(i) as src,(p/i.filename).open('xb') as dst:
   import shutil
   shutil.copyfileobj(src,dst)
m=json.loads((p/'manifest.json').read_text())
assert m['identity']['run']=='44121160900' and m['identity']['attempt']=='1'
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

if ($summary.cli_sha256 -ne '138b488b2c623ccd1d566a0f89129093eb83de69dfca5f12b2e7a7c63b575587') { throw 'Ordinary candidate CLI identity differs' }
$env:PORTCOVE_NEVERBALL_INPUTS = $inputs
@'
import os,urllib.request,hashlib,zipfile,stat,json
from pathlib import Path,PurePosixPath
p=Path(os.environ['PORTCOVE_NEVERBALL_INPUTS'])
url='https://neverball.org/neverball-1.6.0.zip'
with urllib.request.urlopen(url,timeout=90) as r: b=r.read(75802819);final_url=r.url
assert len(b)==75802818 and hashlib.sha256(b).hexdigest()=='865391cc041208e526401a8eb1f14fba44323f17d7e818c5e65e82393ff747fb'
zpath=p/'player.zip';zpath.write_bytes(b);out=p/'player';out.mkdir()
with zipfile.ZipFile(zpath) as z:
 assert len(z.infolist())<2000 and sum(i.file_size for i in z.infolist())<256000000
 for i in z.infolist():
  n=PurePosixPath(i.filename);assert not n.is_absolute() and '..' not in n.parts and chr(92) not in i.filename and ':' not in i.filename
  assert not stat.S_ISLNK(i.external_attr>>16) and i.file_size<128000000
  if i.is_dir():continue
  assert n.parts[0]=='neverball-1.6.0'
  dest=out.joinpath(*n.parts[1:]);dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists()
  with z.open(i) as src,dest.open('xb') as dst:
   import shutil
   shutil.copyfileobj(src,dst)
assert (out/'neverball.exe').is_file()
(p/'title-inputs.json').write_text(json.dumps({'url':url,'final_url':final_url,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'authority':'computed identity from current official download redirect; no publisher expected digest located; user-selected external runtime, not managed admission'},indent=2))
'@ | python -
if ($LASTEXITCODE -ne 0) { throw 'Title input binding failed' }
Copy-Item -LiteralPath (Join-Path $inputs 'title-inputs.json') -Destination evidence/title-inputs.json
$inputs | Set-Content input-root.txt -Encoding utf8
