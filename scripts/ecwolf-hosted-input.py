import sys,io,os,json,hashlib,struct,zipfile,tarfile,shutil
from pathlib import Path
mode=sys.argv[1];root=Path(sys.argv[2]);evidence=root/'evidence'/'desktop-verify'/'ecwolf'/'native'
def digest(p,kind='sha256'):
 with p.open('rb') as f:return hashlib.file_digest(f,kind).hexdigest()
def bounded_zip(data):
 assert len(data)<=200*1024**2
 at=data.rfind(b'PK\x05\x06',max(0,len(data)-65557));assert at>=0
 v=struct.unpack_from('<4s4H2LH',data,at);assert v[1]==v[2]==0 and v[3]==v[4] and v[4]<=100 and v[5]<=1024**2
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
 m=json.loads((root/'manifest.json').read_text());assert m['identity']['run']=='44349465087' and m['identity']['attempt']=='1'
 assert digest(root/'tests.tar.zst')==m['archive_sha256']
 b=(root/'tests.tar.zst').open('rb').read(18);assert b[:4]==bytes.fromhex('28b52ffd') and not(b[4]&32)
 window=(1<<((b[5]>>3)+10));window+=window//8*(b[5]&7);assert window<=256*1024**2
 (root/'decoder-input.json').write_text(json.dumps({'window_bytes':window,'manifest_sha256':digest(root/'manifest.json')}))
elif mode=='tar':
 class BoundedInfo(tarfile.TarInfo):
  count=0;total=0
  def _proc_member(self,archive):
   BoundedInfo.count+=1;BoundedInfo.total+=self.size
   assert self.size>=0 and BoundedInfo.count<=10000 and BoundedInfo.total<=4*1024**3 and self.size<=256*1024**2
   if self.type in (tarfile.XHDTYPE,tarfile.XGLTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_LONGLINK):assert self.size<=1024**2
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
elif mode=='originals':
 expected=json.loads((Path(__file__).parent/'ecwolf-input-identities.json').read_text())
 player=root/'player';player.mkdir()
 rows=[]
 for archive in ['ecwolf-1.4.2_x64.zip','wolf3d14.zip']:
  with bounded_zip((root/archive).read_bytes()) as z:
   targets=expected[archive]
   for name,identity in targets.items():
    i=z.getinfo(name);assert not i.is_dir() and ((i.external_attr>>16)&0o170000)!=0o120000 and i.file_size==identity['bytes']
    b=z.read(i);assert hashlib.sha256(b).hexdigest()==identity['sha256']
    out=player/Path(name).name;assert not out.exists();out.write_bytes(b)
    rows.append({'file':out.name,**identity})
 assert len(list(player.glob('*.WL1')))==8
 assert digest(player/'ecwolf.exe')=='95193ede9c67afa2607b20fdc0d6058e99be4e5cbb03087da172492e5fa3a239'
 (evidence/'external-input-identities.json').write_text(json.dumps(rows,indent=2))
else:raise RuntimeError('Unknown fixed input operation')
