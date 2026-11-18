import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {acquireNativeSessionLock} from '../product/scripts/native-session-lock.mts';
const lease=await acquireNativeSessionLock({workspace:process.cwd(),profile:'openttd-fixed-macos-player',scenarios:['generated-map-exit-save','fresh-profile-reopen','external-registration-preservation']});
const native='evidence/desktop-verify/openttd-macos/native';
let status=1;
let closed=true;
try {
  for (const dataset of ['fresh','replay']) {
    closed=false;
    const child=spawn('xcrun',['swift','-import-objc-header','scripts/openttd-macos-headers.h','scripts/openttd-macos-driver.swift',dataset],{stdio:'inherit'});
    const [code]=await once(child,'close');
    const cleanup=JSON.parse(await readFile(`${native}/${dataset}-cleanup.json`,'utf8').catch(()=>'null'));
    closed=cleanup?.all_owned_processes_exited===true;
    status=code===0&&closed?0:(code||1);
    if(status!==0||!closed) break;
  }
} finally {
  if(closed) await lease.release();
  await writeFile('evidence/admission.json',JSON.stringify({released:closed,scope:'fresh hosted Mac session',reason:closed?'positive owned exit observations':'owned exit unknown; claim retained'}));
}
process.exitCode=status;
