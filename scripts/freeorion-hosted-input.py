import sys,io,os,json,hashlib,struct,zipfile,tarfile,shutil
from pathlib import Path
mode=sys.argv[1];root=Path(sys.argv[2]);evidence=root/'evidence'/'desktop-verify'/'freeorion'/'native'
(evidence/('parser-runtime-'+mode+'.json')).write_text(json.dumps({'python':sys.version,'zipfile_sha256':hashlib.file_digest(Path(zipfile.__file__).open('rb'),'sha256').hexdigest(),'tarfile_sha256':hashlib.file_digest(Path(tarfile.__file__).open('rb'),'sha256').hexdigest(),'supported_tar':'regular, directory, one bounded GNU long-name prefix; PAX/sparse/links rejected before preprocessing','supported_zip':'bounded legacy EOCD; ZIP64 directory override rejected'},indent=2))
def digest(p,kind='sha256'):
 with p.open('rb') as f:return hashlib.file_digest(f,kind).hexdigest()
def bounded_zip(data):
 assert len(data)<=200*1024**2
 at=data.rfind(b'PK\x05\x06',max(0,len(data)-65557));assert at>=0
 v=struct.unpack_from('<4s4H2LH',data,at);assert v[1]==v[2]==0 and v[3]==v[4] and v[4]<=2000 and v[5]<=1024**2
 assert at+22+v[7]==len(data) and v[6]+v[5]<=at
 # Do not let ZipFile replace the checked legacy directory bounds via ZIP64 metadata.
 assert at<20 or data[at-20:at-16]!=b'PK\x06\x07'
 z=zipfile.ZipFile(io.BytesIO(data));assert len(z.infolist())==v[4]
 assert sum(i.file_size for i in z.infolist())<=200*1024**2
 return z
if mode=='outer':
 with bounded_zip((root/'producer.zip').read_bytes()) as z:
  assert set(z.namelist())=={'manifest.json','tests.tar.zst'}
  for i in z.infolist():
   assert not i.is_dir() and ((i.external_attr>>16)&0o170000)!=0o120000
   assert i.file_size <= (4*1024**2 if i.filename=='manifest.json' else 200*1024**2)
   with z.open(i) as src,(root/i.filename).open('xb') as dest:shutil.copyfileobj(src,dest)
 m=json.loads((root/'manifest.json').read_text());assert m['identity']['run']=='44390241368' and m['identity']['attempt']=='1'
 assert digest(root/'tests.tar.zst')==m['archive_sha256']
 b=(root/'tests.tar.zst').open('rb').read(18);assert b[:4]==bytes.fromhex('28b52ffd') and not(b[4]&32)
 window=(1<<((b[5]>>3)+10));window+=window//8*(b[5]&7);assert window<=256*1024**2
 (root/'decoder-input.json').write_text(json.dumps({'window_bytes':window,'manifest_sha256':digest(root/'manifest.json')}))
elif mode=='tar':
 class BoundedInfo(tarfile.TarInfo):
  count=0;total=0;metadata=0;longname_open=False
  def _proc_member(self,archive):
   BoundedInfo.count+=1;BoundedInfo.total+=self.size
   assert self.size>=0 and BoundedInfo.count<=10000 and BoundedInfo.total<=4*1024**3 and self.size<=256*1024**2
   # This producer needs ordinary files/directories and bounded GNU long names only.
   # Reject PAX/sparse/link extensions before tarfile can preprocess their payloads.
   assert self.type in (tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE,tarfile.GNUTYPE_LONGNAME)
   if self.type==tarfile.GNUTYPE_LONGNAME:
    assert not BoundedInfo.longname_open and self.size<=64*1024
    BoundedInfo.metadata+=self.size;assert BoundedInfo.metadata<=1024**2
    BoundedInfo.longname_open=True
   else:BoundedInfo.longname_open=False
   return super()._proc_member(archive)
 found={}
 with tarfile.open(fileobj=sys.stdin.buffer,mode='r|',tarinfo=BoundedInfo) as tar:
  for m in tar:
   key='cli' if m.name=='target/debug/portcove.exe' else 'core' if m.name.startswith('target/debug/deps/portcove_core-') and m.name.endswith('.exe') else None
   if not key:continue
   assert key not in found and m.isfile() and m.size<=256*1024**2
   target=root/('portcove.exe' if key=='cli' else 'core-tests.exe')
   with tar.extractfile(m) as src,target.open('xb') as dest:shutil.copyfileobj(src,dest)
   with target.open('rb') as f:
    b=f.read(4096);off=struct.unpack_from('<I',b,0x3c)[0];assert b[:2]==b'MZ' and off+26<=len(b) and b[off:off+4]==b'PE\0\0' and struct.unpack_from('<H',b,off+4)[0]==0x8664
   found[key]={'sha256':digest(target),'bytes':target.stat().st_size,'archive_path':m.name}
 # tarfile stops at end markers; consume remaining padding under the Node byte/deadline bounds.
 while sys.stdin.buffer.read(65536):pass
 assert set(found)=={'cli','core'}
 (root/'executables.json').write_text(json.dumps(found,indent=2))
elif mode=='player':
 import subprocess,time,stat
 archive=root/'FreeOrion_v0.5.1.2_Win32_Setup.exe'
 # Exact reviewed NSIS bytes bind BZip2 (900KiB maximum block)/343624-byte headers;
 # this is a finite fixture, not a generic installer or archive admission policy.
 assert archive.stat().st_size==191777564 and digest(archive)=='2788f7283bd04987d4bb27984e3a1c24ff5455146b66ee77b89d2aca71cd0907'
 manifest_path=Path('scripts/freeorion-hosted-package.json');assert manifest_path.stat().st_size<3*1024**2
 expected=json.loads(manifest_path.read_text());assert expected['archive_sha256']==digest(archive)
 files={r['path']:r for r in expected['files']};assert len(files)==3477 and sum(r['bytes']for r in files.values())==233351454
 directories=set()
 for name,row in files.items():
  parts=name.split('/');assert all(x and x not in ('.','..') and x.rstrip(' .')==x and not any(c in x for c in ':*?"<>|\\') for x in parts)
  assert row['bytes']<=256*1024**2
  for i in range(1,len(parts)):directories.add('/'.join(parts[:i]))
 assert len({n.casefold()for n in files})==len(files)
 decoder=Path(r'C:\Program Files\7-Zip\7z.exe')
 version=subprocess.run([str(decoder),'i'],capture_output=True,timeout=10,check=True)
 assert len(version.stdout)<=128*1024 and len(version.stderr)<=64*1024
 (evidence/'decoder-runtime-player.json').write_text(json.dumps({'path':str(decoder),'sha256':digest(decoder),'version_output':version.stdout.decode('utf-8',errors='replace')[:4096],'scope':'actual hosted decoder identity and version; fixed reviewed NSIS package, not generic archive qualification'},indent=2))
 target=root/'player';target.mkdir()
 def observe(final=False):
  total=0;seen=set();rows=[]
  for p in target.rglob('*'):
   info=p.lstat();assert not(info.st_file_attributes&stat.FILE_ATTRIBUTE_REPARSE_POINT)
   name=p.relative_to(target).as_posix()
   if p.is_dir():assert name in directories;continue
   assert p.is_file() and name in files and name not in seen;seen.add(name)
   assert info.st_size<=files[name]['bytes'];total+=info.st_size;assert total<=233351454
   if final:
    assert info.st_size==files[name]['bytes'] and digest(p)==files[name]['sha256']
    rows.append(files[name])
  if final:assert seen==set(files) and total==233351454
  return rows
 # Decode into only this new owned directory. Bound disk writes during extraction,
 # process duration and positive child exit; never run the embedded installer.
 log=evidence/'package-decode.log'
 with log.open('xb') as output:
  process=subprocess.Popen([r'C:\Program Files\7-Zip\7z.exe','x','-y','-mmt=2','-bso0','-bsp0','-o'+str(target),str(archive),'-xr!$PLUGINSDIR','-x!Uninstall.exe','-x!vcredist_x86.exe'],stdout=output,stderr=subprocess.STDOUT)
  deadline=time.monotonic()+120
  try:
   while process.poll() is None:
    assert time.monotonic()<deadline and log.stat().st_size<1024**2
    observe();time.sleep(.25)
   assert process.returncode==0
  finally:
   if process.poll() is None:process.kill()
   process.wait(timeout=10)
  (evidence/'package-decode-exit.json').write_text(json.dumps({'positive_exit':process.returncode==0,'exit_code':process.returncode,'installer_executed':False}))
 rows=observe(True)
 with (target/'FreeOrion.exe').open('rb') as f:b=f.read(4096)
 off=struct.unpack_from('<I',b,0x3c)[0];assert b[:2]==b'MZ' and off+26<=len(b) and b[off:off+4]==b'PE\0\0' and struct.unpack_from('<H',b,off+4)[0]==0x8664
 (evidence/'external-package-identities.json').write_text(json.dumps({'files':rows,'expanded_bytes':233351454,'scope':'exact private inert extraction of official complete client payload; installer/uninstaller/redistributable never executed'}))
else:raise RuntimeError('Unknown fixed input operation')
