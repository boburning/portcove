import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {acquireNativeSessionLock} from '../product/scripts/native-session-lock.mts';
const native='evidence/desktop-verify/opentyrian-macos/native';
await mkdir(native,{recursive:true});
const lease=await acquireNativeSessionLock({workspace:process.cwd(),profile:'opentyrian-fixed-macos-player',scenarios:['publisher-mac-menu','normal-exit-profile','external-registration-preservation']});
let status=1;
let closed=false;
try {
  const preparation=spawn('python3',['scripts/opentyrian-macos-input.py'],{stdio:'inherit'});
  const [prepared]=await once(preparation,'close');
  const inputCleanup=JSON.parse(await readFile(`${native}/input-cleanup.json`,'utf8').catch(()=>'null'));
  closed=inputCleanup?.all_owned_operations_closed===true;
  if(prepared===0&&closed) {
    closed=false;
    const input=JSON.parse(await readFile('opentyrian-macos-input.json','utf8'));
    const worker=spawn('xcrun',['swift','-import-objc-header','scripts/opentyrian-macos-headers.h','scripts/opentyrian-macos-driver.swift','menu'],{stdio:'inherit',env:{...process.env,XDG_CONFIG_HOME:`${input.root}/menu/profile`,SDL_RENDER_DRIVER:'software',SDL_AUDIODRIVER:'dummy'}});
    const [code]=await once(worker,'close');
    const cleanup=JSON.parse(await readFile(`${native}/menu-cleanup.json`,'utf8').catch(()=>'null'));
    closed=cleanup?.all_owned_processes_exited===true;
    status=code===0&&closed?0:(code||1);
  }
} finally {
  if(closed) await lease.release();
  await writeFile('evidence/admission.json',JSON.stringify({released:closed,scope:'fresh hosted Mac session',reason:closed?'positive owned mount/process exit observations':'owned closure unknown; claim retained'}));
}
process.exitCode=status;
