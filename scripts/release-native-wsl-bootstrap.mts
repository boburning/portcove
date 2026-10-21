/** Fixed public bootstrap instructions, emitted only by the source-bound
 * installed parent. No source file gets to authenticate itself after import. */
export const nativeWslBootstrap = String.raw`
import hashlib,os,re,stat,subprocess,sys
sys.argv=sys.argv[1:]
def need(ok,message):
 if not ok: raise RuntimeError(message)
def read_hash(filename,maximum,root_owned=False):
 filename=os.path.realpath(filename) if root_owned else filename
 fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and 0<before.st_size<=maximum,'fixed source/tool kind or bound differs')
  if root_owned: need(before.st_uid==0 and not before.st_mode&0o022,'fixed system tool custody differs')
  data=b''
  while len(data)<=maximum:
   part=os.read(fd,min(65536,maximum+1-len(data)))
   if not part: break
   data+=part
  after=os.fstat(fd);need((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) and len(data)==before.st_size,'fixed source/tool changed')
  return data,hashlib.sha256(data).hexdigest()
 finally: os.close(fd)
need(len(sys.argv)>=11,'fixed bootstrap inputs missing')
root,uid,gid,kind,source_sha,python_sha,git_sha,commit,tree=sys.argv[1:10];operation=sys.argv[10:]
need(re.fullmatch(r'/home/[a-z][a-z0-9_-]{0,31}/portcove-native',root) and re.fullmatch(r'[1-9][0-9]{0,9}',uid) and re.fullmatch(r'[1-9][0-9]{0,9}',gid),'fixed guest root/account differs')
need(os.getuid()==int(uid) and os.getgid()==int(gid),'actual nonroot guest identity differs')
need(kind in ('outer','transfer') and all(re.fullmatch(r'[a-f0-9]{64}',v) for v in (source_sha,python_sha,git_sha)) and all(re.fullmatch(r'[a-f0-9]{40}',v) for v in (commit,tree)),'fixed bootstrap identities differ')
need(read_hash('/usr/bin/python3',128*1024*1024,True)[1]==python_sha and read_hash('/proc/self/exe',128*1024*1024,True)[1]==python_sha,'actual isolated Python differs')
need(read_hash('/usr/bin/git',64*1024*1024,True)[1]==git_sha,'fixed Git differs')
filename=root+'/controller/scripts/'+('native-qualification-linux-supervisor.py' if kind=='outer' else 'native-qualification-linux-transfer.py')
source,actual=read_hash(filename,1024*1024);need(actual==source_sha,'fixed guest entry source differs before execution')
env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':root,'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_LAZY_FETCH':'1','GIT_NO_REPLACE_OBJECTS':'1'}
def git(args):
 p=subprocess.run(['/usr/bin/git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root+'/controller']+args,env=env,stdin=subprocess.DEVNULL,capture_output=True,timeout=10,check=False)
 need(p.returncode==0 and len(p.stdout)<=65536 and len(p.stderr)<=4096,'fixed controller source read refused');return p.stdout.decode('utf-8').strip()
need(git(['rev-parse','HEAD'])==commit and git(['rev-parse','HEAD^{tree}'])==tree and not git(['status','--porcelain','--untracked-files=no']),'fixed controller source/tree is not clean')
need(len(operation) in (4,6,8) and operation[0]=='--mode' and operation[2]=='--invocation' and re.fullmatch(r'[a-f0-9]{64}',operation[3]),'fixed guest operation tuple differs')
if kind=='outer':
 need(operation[1] in ('run','readback','settle','unit-entry') and len(operation)==(8 if operation[1]=='unit-entry' else 6) and operation[4]=='--request-sha256' and re.fullmatch(r'[a-f0-9]{64}',operation[5]),'fixed outer operation differs')
 if operation[1]=='unit-entry': need(operation[6]=='--nonce' and re.fullmatch(r'[a-f0-9]{64}',operation[7]),'fixed readiness nonce differs')
else:
 need((operation[1] in ('capture','host') and len(operation)==4) or (operation[1]=='stage' and len(operation)==6 and operation[4]=='--header-sha256' and re.fullmatch(r'[a-f0-9]{64}',operation[5])),'fixed transfer operation differs')
bootstrap=sys.argv[0];prefix=[root,uid,gid,kind,source_sha,python_sha,git_sha,commit,tree]
def bootstrap_argv(args):
 need(kind=='outer','only fixed outer source can prepare its unit entry')
 return ['/usr/bin/python3','-I','-S','-B','-c',bootstrap,bootstrap]+prefix+list(args)
sys.argv=[filename]+operation
exec(compile(source,filename,'exec'),{'__name__':'__main__','__file__':filename,'_native_bootstrap_argv':bootstrap_argv})
`;

export interface NativeWslEntryPins {
  supervisor_sha256: string;
  transfer_sha256: string;
  controller_revision: string;
  controller_tree: string;
}
export function inspectNativeWslEntryPins(raw: unknown): NativeWslEntryPins {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !==
      "controller_revision,controller_tree,supervisor_sha256,transfer_sha256"
  )
    throw new Error("fixed guest entry pins differ");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.supervisor_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.supervisor_sha256) ||
    typeof value.transfer_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.transfer_sha256) ||
    typeof value.controller_revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller_revision) ||
    typeof value.controller_tree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.controller_tree)
  )
    throw new Error("fixed guest entry identity missing");
  return Object.freeze({
    supervisor_sha256: value.supervisor_sha256,
    transfer_sha256: value.transfer_sha256,
    controller_revision: value.controller_revision,
    controller_tree: value.controller_tree,
  });
}
export function nativeWslBootstrapArguments(
  root: string,
  uid: string,
  gid: string,
  kind: "outer" | "transfer",
  pins: NativeWslEntryPins,
  python: string,
  git: string,
  operation: readonly string[],
) {
  if (
    !/^\/home\/[a-z][a-z0-9_-]{0,31}\/portcove-native$/u.test(root) ||
    !/^[1-9][0-9]{0,9}$/u.test(uid) ||
    !/^[1-9][0-9]{0,9}$/u.test(gid)
  )
    throw new Error("fixed guest root/account differs");
  for (const value of [pins.supervisor_sha256, pins.transfer_sha256, python, git])
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("fixed guest entry pin missing");
  for (const value of [pins.controller_revision, pins.controller_tree])
    if (!/^[a-f0-9]{40}$/u.test(value)) throw new Error("fixed guest source identity missing");
  // -c normally sets argv[0] to '-c'. Pass the actual immutable source as the
  // first public argument so an authenticated outer can reapply this same guard
  // to its systemd unit-entry before that source is imported again.
  return Object.freeze([
    "-I",
    "-S",
    "-B",
    "-c",
    nativeWslBootstrap,
    nativeWslBootstrap,
    root,
    uid,
    gid,
    kind,
    kind === "outer" ? pins.supervisor_sha256 : pins.transfer_sha256,
    python,
    git,
    pins.controller_revision,
    pins.controller_tree,
    ...operation,
  ]);
}
