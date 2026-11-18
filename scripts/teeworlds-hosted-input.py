import sys,io,os,json,hashlib,struct,zipfile,tarfile,shutil
from pathlib import Path
mode=sys.argv[1];root=Path(sys.argv[2]);evidence=root/'evidence'/'desktop-verify'/'teeworlds'/'native'
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
 m=json.loads((root/'manifest.json').read_text());assert m['identity']['run']=='44366940975' and m['identity']['attempt']=='1'
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
 archive=root/'teeworlds-0.7.5-win64.zip';assert digest(archive)=='83cd75884a0e8339b4910da1bfe4d737af794d35600cd065e7c2222750b37585'
 target=root/'player';target.mkdir();rows=[];seen=set();decoded=0
 with bounded_zip(archive.read_bytes()) as z:
  assert len(z.infolist())==665 and sum(i.file_size for i in z.infolist())<=64*1024**2
  for i in z.infolist():
   assert i.filename.startswith('teeworlds-0.7.5-win64/') and '\\' not in i.filename and i.file_size<=8*1024**2
   name=i.filename[len('teeworlds-0.7.5-win64/'):].rstrip('/')
   if not name:assert i.is_dir();continue
   parts=name.split('/');assert all(x and x not in ('.','..') and x.rstrip(' .')==x and not any(c in x for c in ':*?"<>|') for x in parts)
   assert all(x.split('.')[0].upper() not in ['CON','PRN','AUX','NUL',*[f'COM{n}' for n in range(1,10)],*[f'LPT{n}' for n in range(1,10)]] for x in parts)
   assert name.casefold() not in seen;seen.add(name.casefold());assert ((i.external_attr>>16)&0o170000) in (0,0o100000,0o040000)
   out=target.joinpath(*parts)
   if i.is_dir():out.mkdir(parents=True,exist_ok=True);continue
   out.parent.mkdir(parents=True,exist_ok=True)
   with z.open(i) as src,out.open('xb') as dest:
    while b:=src.read(65536):decoded+=len(b);assert decoded<=64*1024**2;dest.write(b)
   rows.append({'path':name,'bytes':out.stat().st_size,'sha256':digest(out)})
 assert digest(target/'teeworlds.exe')=='5ab62aefe62b75eebc4f849c0773caecb4a051ea930fa95c8384885c248dda04'
 assert (target/'teeworlds_srv.exe').is_file() and (target/'data'/'maps'/'dm1.map').is_file()
 with (target/'teeworlds.exe').open('rb') as f:b=f.read(4096)
 off=struct.unpack_from('<I',b,0x3c)[0];assert b[:2]==b'MZ' and off+26<=len(b) and b[off:off+4]==b'PE\0\0' and struct.unpack_from('<H',b,off+4)[0]==0x8664
 (evidence/'external-package-identities.json').write_text(json.dumps({'files':rows,'expanded_bytes':decoded,'server_executed':False},indent=2))
else:raise RuntimeError('Unknown fixed input operation')
