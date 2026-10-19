import {spawnSync,spawn} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,symlinkSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {pathToFileURL} from "node:url";
const checkout=process.cwd();
const evidence=path.join(checkout,"work/fallow-reports/walkthrough");
const node=process.execPath;
const cli=path.join(checkout,"node_modules/fallow/bin/fallow");
const baseline="05da1abb3b448700bfc9ff08918a4e94ff47f395";
mkdirSync(evidence,{recursive:true});
const env={...process.env,FALLOW_AGENT_SOURCE:"codex",FALLOW_CACHE_DIR:path.join(evidence,"cache")};
for(const key of ["FALLOW_PRODUCTION","FALLOW_PRODUCTION_DEAD_CODE","FALLOW_PRODUCTION_HEALTH","FALLOW_PRODUCTION_DUPES","FALLOW_PACKAGE_BASELINES","FALLOW_MAX_FILE_SIZE","FALLOW_TYPE_AWARE","FALLOW_TYPE_AWARE_BIN","FALLOW_AUDIT_BASE","FALLOW_CLOCK_EPOCH","FALLOW_DIFF_FILE","FALLOW_CHANGED_SINCE","FALLOW_COVERAGE","FALLOW_COVERAGE_ROOT"])delete env[key];
env.FALLOW_TYPE_AWARE_TIMEOUT_SECS="40";
const results=[];
const trialStarted=Date.now();
const hash=b=>createHash("sha256").update(b).digest("hex");
async function command(name,args,{cwd=checkout,timeout=65000,environment=env,executable=node}={}){
  if(Date.now()-trialStarted>240000){ const item={name,status:null,elapsed_ms:0,error:{code:"TRIAL_TOTAL_BUDGET",message:"Optional trial total240s budget reached"}}; results.push(item);writeFileSync(path.join(evidence,"commands.json"),JSON.stringify(results,null,2));return {item,report:null,stdout:""}; }
  console.log("TRIAL "+name);
  const started=Date.now();
  const r=await new Promise(resolve=>{
    const child=spawn(executable,args,{cwd,env:environment,windowsHide:true,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",error=null,timedOut=false;
    const stop=()=>{try{if(process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL")}catch{}};
    child.stdout.on("data",data=>{stdout+=data;if(stdout.length>32*1024*1024){error={name:"Error",code:"MAXBUFFER",message:"Trial output exceeds32MiB"};stop()}});
    child.stderr.on("data",data=>{stderr+=data;if(stderr.length>4*1024*1024){error={name:"Error",code:"MAXBUFFER",message:"Trial stderr exceeds4MiB"};stop()}});
    const timer=setTimeout(()=>{timedOut=true;error={name:"Error",code:"ETIMEDOUT",message:"Finite trial subprocess budget exceeded"};stop()},Math.min(timeout,60000));
    child.on("error",e=>{error=e});
    child.on("close",(status,signal)=>{clearTimeout(timer);if(timedOut)stop();resolve({status,signal,error,stdout,stderr})});
  });
  const stdout=r.stdout??"",stderr=r.stderr??"";
  writeFileSync(path.join(evidence,name+".stdout"),stdout);
  writeFileSync(path.join(evidence,name+".stderr"),stderr);
  let report;try{report=JSON.parse(stdout)}catch{}
  const item={name,executable,args,cwd,elapsed_ms:Date.now()-started,status:r.status,signal:r.signal,error:r.error?{name:r.error.name,code:r.error.code,message:r.error.message}:null,stdout_sha256:hash(stdout),stderr_sha256:hash(stderr),report_kind:report?.kind??null,schema_version:report?.schema_version??null};
  results.push(item);writeFileSync(path.join(evidence,"commands.json"),JSON.stringify(results,null,2)+"\n");
  console.log(JSON.stringify({name,status:item.status,elapsed_ms:item.elapsed_ms,kind:item.report_kind,error:item.error?.code}));
  if(r.error) console.error("Retained bounded trial failure: "+name+" "+r.error.code);
  return {item,report,stdout};
}

async function walkthrough(){
 const request=process.env.COMPARISON_BASE??"";
 const identity={head:spawnSync("git",["rev-parse","HEAD"],{cwd:checkout,encoding:"utf8"}).stdout.trim(),base:baseline,observed_at:new Date().toISOString(),version:JSON.parse(readFileSync(path.join(checkout,"node_modules/fallow/package.json"),"utf8")).version,scope:"Advisory agent-contract walkthrough only; anchor validation does not establish reviewer reasoning or behavior correctness"};
 writeFileSync(path.join(evidence,"identity.json"),JSON.stringify(identity,null,2));
 let selection=["--walkthrough-guide"];
 if(request.startsWith("judgment:")){
   const encoded=request.slice("judgment:".length);
   if(encoded.length>120000||!encoded||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error("Invalid bounded base64 judgment input");
   const decoded=Buffer.from(encoded,"base64").toString("utf8");
   const judgment=JSON.parse(decoded);
   if(judgment===null||typeof judgment!=="object"||typeof judgment.graph_snapshot_hash!=="string"||!Array.isArray(judgment.judgments))throw Error("Judgment must provide graph snapshot and judgment array");
   const judgmentPath=path.join(evidence,"judgment.json");
   writeFileSync(judgmentPath,JSON.stringify(judgment,null,2));
   selection=["--walkthrough-file",judgmentPath];
 }
 const name=selection[0]==="--walkthrough-guide"?"guide":"validation";
 const result=await command(name,[cli,"review","--root",checkout,"--config",path.join(checkout,".fallow-tooling.json"),"--base",baseline,...selection,"--threads","2","--format","json","--quiet","--explain","--no-production","--no-package-baselines","--no-type-aware","--max-file-size","5"],{timeout:60000});
 writeFileSync(path.join(evidence,"complete.json"),JSON.stringify({completed_at:new Date().toISOString(),request:name,status:result.item.status,error:result.item.error,kind:result.report?.kind??null,available:Boolean(result.report&&!result.report.error&&result.item.status===0),meaning:"Native accepted anchors and snapshot identity only; prose reasoning and behavior verification remain reviewer responsibilities"},null,2));
 return 0;
}
const {resourceEntrypoint}=await import(pathToFileURL(path.join(checkout,"scripts/resource-command.mts")));
process.exitCode=await resourceEntrypoint("analysis",walkthrough,{cwd:checkout});
