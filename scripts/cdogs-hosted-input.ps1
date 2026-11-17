$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$inputs = Join-Path $env:RUNNER_TEMP 'cdogs-exact-input'
New-Item -ItemType Directory -Path $inputs | Out-Null
$headers = @{Authorization="Bearer $env:GH_TOKEN"; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
$api = 'https://api.github.com/repos/boburning/portcove'
$artifact = Invoke-RestMethod -Headers $headers -Uri "$api/actions/artifacts/14347807526"
if ($artifact.id -ne 14347807526 -or $artifact.expired -or $artifact.workflow_run.id -ne 44121160900 -or $artifact.workflow_run.head_sha -ne $env:PORTCOVE_PRODUCT_SOURCE -or $artifact.digest -ne 'sha256:fd02092b035eea76d6e0d6857695335a9a2c1c6a9cc695d3ad92dc01b0932afe') { throw 'Producer artifact identity differs' }
$zip = Join-Path $inputs 'producer.zip'
Invoke-WebRequest -Headers $headers -Uri "$api/actions/artifacts/14347807526/zip" -OutFile $zip
if ((Get-Item $zip).Length -ne 185051047 -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.digest.Substring(7)) { throw 'Producer artifact bytes differ' }
$env:PORTCOVE_CDOGS_INPUTS = $inputs
@'
import os,zipfile,json,hashlib
from pathlib import Path
p=Path(os.environ['PORTCOVE_CDOGS_INPUTS'])
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

$playerZip = Join-Path $inputs 'player.zip'
& curl.exe --fail --location --silent --show-error --max-time 120 --max-filesize 36000000 --output $playerZip 'https://github.com/cxong/cdogs-sdl/releases/download/2.5.0/C-Dogs.SDL-2.5.0-win32.zip'
if ($LASTEXITCODE -ne 0) { throw 'Explicit qualification input download failed' }
$env:PORTCOVE_CDOGS_INPUTS = $inputs
@'
import os,hashlib,zipfile,stat,json,struct,shutil
from pathlib import Path,PurePosixPath
p=Path(os.environ['PORTCOVE_CDOGS_INPUTS']);zpath=p/'player.zip'
assert zpath.stat().st_size==34071179
with zpath.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()=='448409739c4409cc188f5342fdcb95aa1beea10c9cb87d3021fc471a47e8e5fc'
out=p/'player';out.mkdir()
with zipfile.ZipFile(zpath) as z:
 es=z.infolist();assert len(es)==3805 and sum(i.file_size for i in es)==40968785
 for i in es:
  n=PurePosixPath(i.filename)
  assert not n.is_absolute() and '..' not in n.parts and chr(92) not in i.filename and ':' not in i.filename
  assert not stat.S_ISLNK(i.external_attr>>16) and i.file_size<64000000
  assert n.parts[0]=='C-Dogs.SDL-2.5.0-win32'
  if i.is_dir():continue
  assert len(n.parts)>1
  dest=out.joinpath(*n.parts[1:]);dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists()
  with z.open(i) as src,dest.open('xb') as dst:shutil.copyfileobj(src,dst)
b=(out/'bin/cdogs-sdl.exe').read_bytes();off=struct.unpack_from('<I',b,0x3c)[0]
assert b[:2]==b'MZ' and b[off:off+4]==b'PE\0\0' and struct.unpack_from('<H',b,off+4)[0]==0x14c
assert hashlib.sha256(b).hexdigest()=='3d766f2f36c533bbd08f2e198eda70c4f973b49287525d210cc4756f6dad56c6'
assert b'XDG_CONFIG_HOME' in b and b'CDOGS_CONFIG_DIR' in b
(p/'title-inputs.json').write_text(json.dumps({'release':'2.5.0','asset_id':646854937,'zip_bytes':34071179,'publisher_sha256':'448409739c4409cc188f5342fdcb95aa1beea10c9cb87d3021fc471a47e8e5fc','player_sha256':hashlib.sha256(b).hexdigest(),'machine':'Win32 i386','scope':'explicit qualification of non-owning existing-player route; publisher bundle acquisition hold remains unchanged; no Wolfenstein campaign selected'},indent=2))
'@ | python -
if ($LASTEXITCODE -ne 0) { throw 'Title input verification failed' }
Copy-Item -LiteralPath (Join-Path $inputs 'title-inputs.json') -Destination evidence/title-inputs.json
$inputs | Set-Content input-root.txt -Encoding utf8
