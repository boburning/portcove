import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {acquireNativeSessionLock} from '../product/scripts/native-session-lock.mts';
const lease=await acquireNativeSessionLock({workspace:process.cwd(),profile:'openttd-exact-windows-player',scenarios:['new-map-exit-save-and-fresh-profile-reopen-normal-exit']});
let result=1;
try {
 for (const dataset of ['new','replay']) {
 await rm('evidence/cleanup.json',{force:true});
 const child=spawn('pwsh',['-NoProfile','-File','scripts/openttd-hosted-startup.ps1','-Dataset',dataset],{stdio:'inherit'});
 const [code]=await once(child,'close'); result=code??1;
 await writeFile(`evidence/cleanup-${dataset}.json`,await readFile('evidence/cleanup.json'));
 if(result!==0) break;
 }
} finally {
 const cleanup=JSON.parse(await readFile('evidence/cleanup.json','utf8').catch(()=>'null'));
 if (cleanup?.positive_exit===true) {await lease.release();await writeFile('evidence/admission.json',JSON.stringify({released:true}));}
 else {await writeFile('evidence/admission.json',JSON.stringify({released:false,reason:'positive owned exit not established; hosted claim retained'}));}
}
process.exitCode=result;
