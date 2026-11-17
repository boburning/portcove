import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {acquireNativeSessionLock} from '../product/scripts/native-session-lock.mts';
const lease=await acquireNativeSessionLock({workspace:process.cwd(),profile:'corsix-exact-windows-startup',scenarios:['official-package-fresh-profile-picker-normal-exit']});
let result=1;
try {
 const child=spawn('pwsh',['-NoProfile','-File','scripts/corsix-hosted-startup.ps1'],{stdio:'inherit'});
 const [code]=await once(child,'close'); result=code??1;
} finally {
 const cleanup=JSON.parse(await readFile('evidence/cleanup.json','utf8').catch(()=>'null'));
 if (cleanup?.positive_exit===true) {await lease.release();await writeFile('evidence/admission.json',JSON.stringify({released:true}));}
 else {await writeFile('evidence/admission.json',JSON.stringify({released:false,reason:'positive owned exit not established; hosted claim retained'}));}
}
process.exitCode=result;
