$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$inputs = Join-Path $env:RUNNER_TEMP 'street-rod-exact-input'
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
$env:PORTCOVE_STREET_INPUTS = $inputs
@'
import os,urllib.request,hashlib,zipfile,stat,json
from pathlib import Path,PurePosixPath
p=Path(os.environ['PORTCOVE_STREET_INPUTS'])
items=[('player','https://github.com/kylofon/street-rod-sdl3/releases/download/v0.1.0/srport-v0.1.0-win64.zip','a63f53df7c771de650ce123a536880a739581a60f4789f817e8c7904c3d96804',10817752),('original','https://www.streetrodonline.com/wp-content/uploads/2017/05/sr1pc.zip','74bbf38bea126cdfd6085e44827e9c193f9f27829619f38f8dbfe353ac7354d9',None),('se','https://www.streetrodonline.com/wp-content/uploads/2017/05/srsepc.zip','0e91fefdbc5dea95291da05480b6f9647b7caa35d5f29a18223f0c0edf18cb12',None)]
receipt=[]
for name,url,digest,size in items:
 with urllib.request.urlopen(url,timeout=60) as r: b=r.read(16000001)
 assert len(b)<=16000000 and (size is None or len(b)==size) and hashlib.sha256(b).hexdigest()==digest
 zpath=p/(name+'.zip');zpath.write_bytes(b);out=p/name;out.mkdir()
 with zipfile.ZipFile(zpath) as z:
  assert len(z.infolist())<500 and sum(i.file_size for i in z.infolist())<64000000
  for i in z.infolist():
   n=PurePosixPath(i.filename);assert not n.is_absolute() and '..' not in n.parts and '\\' not in i.filename and ':' not in i.filename
   assert not stat.S_ISLNK(i.external_attr>>16) and i.file_size<16000000
   if i.is_dir() or '__MACOSX' in n.parts or n.name=='.DS_Store':continue
   # Owner DOS distributions have one SR1/SRSE root; copies stay separate.
   dest=out.joinpath(*(n.parts if name=='player' else n.parts[1:]));dest.parent.mkdir(parents=True,exist_ok=True)
   assert not dest.exists()
   with z.open(i) as src,dest.open('xb') as dst:
    import shutil
    shutil.copyfileobj(src,dst)
 receipt.append({'name':name,'url':url,'sha256':digest,'bytes':len(b),'authority':'publisher digest' if name=='player' else 'computed identity of copyright-owner download; not catalog digest authority'})
assert (p/'player/srport.exe').is_file() and (p/'original/SR.EXE').is_file() and (p/'se/SRSE.EXE').is_file()
(p/'title-inputs.json').write_text(json.dumps(receipt,indent=2))
'@ | python -
if ($LASTEXITCODE -ne 0) { throw 'Title input binding failed' }
Copy-Item -LiteralPath (Join-Path $inputs 'title-inputs.json') -Destination evidence/title-inputs.json
$inputs | Set-Content input-root.txt -Encoding utf8
