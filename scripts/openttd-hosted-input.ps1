$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$inputs = Join-Path $env:RUNNER_TEMP 'openttd-exact-input'
New-Item -ItemType Directory -Path $inputs | Out-Null
$headers = @{Authorization="Bearer $env:GH_TOKEN"; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
$api = 'https://api.github.com/repos/boburning/portcove'
$artifact = Invoke-RestMethod -Headers $headers -Uri "$api/actions/artifacts/14347807526"
if ($artifact.id -ne 14347807526 -or $artifact.expired -or $artifact.workflow_run.id -ne 44121160900 -or $artifact.workflow_run.head_sha -ne $env:PORTCOVE_PRODUCT_SOURCE -or $artifact.digest -ne 'sha256:fd02092b035eea76d6e0d6857695335a9a2c1c6a9cc695d3ad92dc01b0932afe') { throw 'Producer artifact identity differs' }
$zip = Join-Path $inputs 'producer.zip'
Invoke-WebRequest -Headers $headers -Uri "$api/actions/artifacts/14347807526/zip" -OutFile $zip
if ((Get-Item $zip).Length -ne 185051047 -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.digest.Substring(7)) { throw 'Producer artifact bytes differ' }
$env:PORTCOVE_OPENTTD_INPUTS = $inputs
@'
import os,zipfile,json,hashlib
from pathlib import Path
p=Path(os.environ['PORTCOVE_OPENTTD_INPUTS'])
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
$graphicsZip = Join-Path $inputs 'graphics.zip'
& curl.exe --fail --location --silent --show-error --max-time 90 --max-filesize 16000000 --output $playerZip 'https://cdn.openttd.org/openttd-releases/15.3/openttd-15.3-windows-win64.zip'
if ($LASTEXITCODE -ne 0) { throw 'Publisher player download failed' }
& curl.exe --fail --location --silent --show-error --max-time 90 --max-filesize 6000000 --output $graphicsZip 'https://cdn.openttd.org/opengfx-releases/8.0/opengfx-8.0-all.zip'
if ($LASTEXITCODE -ne 0) { throw 'Publisher graphics download failed' }
$env:PORTCOVE_OPENTTD_INPUTS = $inputs
@'
import os,hashlib,zipfile,stat,json,struct
from pathlib import Path,PurePosixPath
p=Path(os.environ['PORTCOVE_OPENTTD_INPUTS'])
items=[('player','61c0a6a43d81008c7ff4330fb56351bbf66a980cdad041f1d0e08b51f2eeb34c',11250350),('graphics','43a0c1dabf39cb865394f3a6cc36d4da5c10ecfaaf55652043104806810903be',3583152)]
r=[]
for name,digest,size in items:
 path=p/(name+'.zip');assert path.stat().st_size==size
 with path.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==digest
 out=p/name;out.mkdir()
 with zipfile.ZipFile(path) as z:
  es=z.infolist();assert len(es)<5000 and sum(i.file_size for i in es)<150000000
  for i in es:
   n=PurePosixPath(i.filename);assert not n.is_absolute() and '..' not in n.parts and chr(92) not in i.filename and ':' not in i.filename
   assert not stat.S_ISLNK(i.external_attr>>16) and i.file_size<64000000
   if i.is_dir():continue
   if name=='player':assert n.parts[0]=='openttd-15.3-windows-win64'
   parts=n.parts[1:] if name=='player' else n.parts
   assert parts
   dest=out.joinpath(*parts);dest.parent.mkdir(parents=True,exist_ok=True);assert not dest.exists()
   with z.open(i) as src,dest.open('xb') as dst:
    import shutil
    shutil.copyfileobj(src,dst)
  if name=='graphics':assert z.namelist()==['opengfx-8.0.tar']
 r.append({'name':name,'publisher_sha256':digest,'bytes':size,'authority':'publisher downloads page independently verified before probe'})
exe=p/'player/openttd.exe';b=exe.read_bytes();off=struct.unpack_from('<I',b,0x3c)[0]
assert b[:2]==b'MZ' and b[off:off+4]==b'PE\0\0' and struct.unpack_from('<H',b,off+4)[0]==0x8664
assert hashlib.sha256(b).hexdigest()=='360f615cb74cafcedf0486398a396577e8f1470e0f8158f66b7e29557fdb711d'
(p/'title-inputs.json').write_text(json.dumps({'archives':r,'player_sha256':hashlib.sha256(b).hexdigest(),'player_publisher_page':'https://www.openttd.org/downloads/openttd-releases/latest','graphics_publisher_page':'https://www.openttd.org/downloads/opengfx-releases/latest','graphics_tar_sha256':hashlib.sha256((p/'graphics/opengfx-8.0.tar').read_bytes()).hexdigest(),'scope':'fixed official Windows x64 package and free OpenGFX; no retail originals or runtime/library injection'},indent=2))
'@ | python -
if ($LASTEXITCODE -ne 0) { throw 'Title input verification failed' }
Copy-Item -LiteralPath (Join-Path $inputs 'title-inputs.json') -Destination evidence/title-inputs.json
$inputs | Set-Content input-root.txt -Encoding utf8
