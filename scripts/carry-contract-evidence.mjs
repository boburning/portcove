import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const expected='6d7166f0e671dae8684ccbec75d36004652123af';
const root=process.cwd(), product=path.join(root,'product');
const git=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:15000,maxBuffer:1024*1024}).trim();
if(git(['rev-parse','HEAD'],product)!==expected || process.env.PORTCOVE_PRODUCT_SOURCE!==expected || git(['rev-parse','HEAD'],root)!==process.env.PORTCOVE_CONTROLLER_SOURCE) throw Error('Exact source/controller differs');
const output=path.join(root,'evidence/desktop-verify/carry-contract/native');fs.mkdirSync(output,{recursive:true});
const names=['transport-schemas.generated.json','transport-inputs.generated.json','transport-host-input.generated.json','transport-host-output.generated.json','transport-host-events.generated.json','catalog-values.generated.ts','transport-types.generated.d.ts','transport-input-types.generated.d.ts','transport-event-types.generated.d.ts'];
const allowed=new Set(names.map(n=>'apps/desktop/src/'+n));
const changed=git(['diff','--name-only'],product).split('\n').filter(Boolean);
if(changed.some(n=>!allowed.has(n))) throw Error('Exporter changed an unapproved tracked file');
let total=0;const records=[];
function copy(source,name,origin){
 const stat=fs.lstatSync(source);
 if(!stat.isFile() || stat.isSymbolicLink() || stat.size>4*1024*1024 || (total+=stat.size)>10*1024*1024)throw Error('Output exceeds regular-file or byte bound');
 const data=fs.readFileSync(source);fs.writeFileSync(path.join(output,name),data,{flag:'wx'});
 records.push({source:origin,evidence:name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});
}
for(const n of names)copy(path.join(product,'apps/desktop/src',n),n.endsWith('.json')?n:n+'.log','apps/desktop/src/'+n);
for(const n of ['export','types','core','counts','cli']){
 const source=path.join(product,'work/carry-contract',n+'.log');
 if(fs.existsSync(source))copy(source,n+'.log','work/carry-contract/'+n+'.log');
}
const complete=fs.existsSync(path.join(product,'work/carry-contract/commands-complete.json'));
if(complete)for(const n of ['core','counts','cli']){
 const log=fs.readFileSync(path.join(output,n+'.log'),'utf8');
 if(!/test result: ok\. [1-9][0-9]* passed;/.test(log))throw Error('A selected test command did not report a positive test count');
}
const command=(exe,args)=>execFileSync(exe,args,{cwd:product,encoding:'utf8',timeout:15000,maxBuffer:64*1024}).trim();
fs.writeFileSync(path.join(root,'evidence/generation.json'),JSON.stringify({product:expected,controller:process.env.PORTCOVE_CONTROLLER_SOURCE,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,os:process.platform,arch:process.arch,node:process.version,rust:command('rustc',['--version']),image:process.env.ImageVersion,export_complete:fs.existsSync(path.join(product,'work/carry-contract/export-complete.json')),types_complete:fs.existsSync(path.join(product,'work/carry-contract/types-complete.json')),commands_complete:complete,changed,records,scope:'source snapshots and a compiled-export/fixture attempt; generated acceptance requires completed export/types/commands and actual successful workflow; no native application/gameplay or final-product CI acceptance'},null,2));
