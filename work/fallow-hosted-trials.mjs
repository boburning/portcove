import {spawnSync,spawn} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,symlinkSync,existsSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {pathToFileURL} from "node:url";
const checkout=process.cwd();
const evidence=path.join(checkout,"work/fallow-reports/trials");
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
const presentation=["--threads","2","--format","json","--quiet","--explain","--no-production","--no-package-baselines","--max-file-size","5"];
async function native(name,args,{root=checkout,config,semantic=false,...options}={}){
 const all=[cli,...args,"--root",root,...(config?["--config",config]:[]),...presentation,...(semantic?[]:["--no-type-aware"])];
 return await command(name,all,options);
}
function git(args,cwd=checkout){const r=spawnSync("git",args,{cwd,env,encoding:"utf8",windowsHide:true,maxBuffer:8*1024*1024});if(r.status!==0)throw Error("git failed "+args.join(" ")+": "+r.stderr);return r.stdout.trim();}
function copyBaseline(relative,destination){const r=spawnSync("git",["show",baseline+":"+relative],{cwd:checkout,env,windowsHide:true,maxBuffer:8*1024*1024});if(r.status!==0)throw Error("baseline read failed");const target=path.join(destination,relative);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,r.stdout);return {path:relative,sha256:hash(r.stdout),bytes:r.stdout.length};}
function initFixture(directory){mkdirSync(path.join(directory,"empty-hooks"),{recursive:true});git(["init","-q"],directory);git(["config","core.hooksPath",path.join(directory,"empty-hooks")],directory);git(["add","."],directory);git(["-c","user.name=Portcove bounded trial","-c","user.email=trial@portcove.invalid","-c","commit.gpgsign=false","commit","-qm","Retained bounded native trial fixture"],directory);}
function inspectPlan(name,result,target,limit){
 const p=result.report;
 const valid=result.item.status===0&&p?.kind==="mutation-plan"&&Array.isArray(p.files)&&p.files.length===1&&p.files[0].path===target&&Array.isArray(p.mutants)&&p.mutants.every(m=>m.file===target)&&Array.isArray(p.test_files)&&p.test_files.length>0&&p.counts?.planned<=limit;
 const inspection={valid,target,limit,counts:p?.counts,files:p?.files,test_files:p?.test_files,first_mutants:p?.mutants?.slice(0,limit),meaning:"Only disposable exact source copy, single target, maintained static test reach, finite planned count; no source checkout mutation"};
 writeFileSync(path.join(evidence,name+"-inspection.json"),JSON.stringify(inspection,null,2));
 console.log(JSON.stringify({mutation_plan:name,...inspection}));
 return valid;
}
async function trials(){
 const identity={baseline,checkout,head:git(["rev-parse","HEAD"]),observed_at:new Date().toISOString(),node,version:JSON.parse(readFileSync(path.join(checkout,"node_modules/fallow/package.json"),"utf8")).version,scope:"Native optional trial only; no acceptance, gate or full audit completion inferred."};
 writeFileSync(path.join(evidence,"identity.json"),JSON.stringify(identity,null,2)+"\n");
 await command("native-schema",[cli,"schema","--format","json","--quiet"],{timeout:15000});
 await command("type-aware-status",[cli,"type-aware","status","--root",path.join(checkout,"apps/desktop"),"--format","json","--quiet"],{timeout:15000});
 await native("desktop-guard",["guard","src/shared/concurrency-state.ts","src/features/browsing/CatalogFilters.tsx"],{root:path.join(checkout,"apps/desktop"),timeout:15000});
 await native("desktop-inspect",["inspect","--file","src/shared/concurrency-state.ts"],{root:path.join(checkout,"apps/desktop")});
 await native("dependency-sites",["trace","--dependency","@tauri-apps/api","--sites","--limit","10"],{root:path.join(checkout,"apps/desktop")});
 for(const completeness of ["best-effort","complete"]){
   await native("symbol-impact-"+completeness,["dead-code","--type-aware","--type-aware-project","tsconfig.json","--type-aware-require",completeness,"--symbol-impact","src/shared/concurrency-state.ts:LatestRequestGeneration"],{root:path.join(checkout,"apps/desktop"),semantic:true,timeout:55000});
 }
 const react=JSON.parse(readFileSync(path.join(checkout,"apps/desktop/.fallowrc.json"),"utf8"));
 react.rules={...react.rules,"absent-component-props":"warn","prop-drilling":"warn","thin-wrapper":"warn","duplicate-prop-shape":"warn"};
 const reactPath=path.join(evidence,"react-trial-config.json");writeFileSync(reactPath,JSON.stringify(react,null,2)+"\n");
 await native("react-opt-ins",["dead-code",...["src/App.tsx","src/components/Chrome.tsx","src/components/DetailPanel.tsx","src/components/SourceIntake.tsx","src/components/PortBrowser.tsx","src/components/ExternalRuntime.tsx","src/components/GameUpdates.tsx","src/components/UpdateCenter.tsx","src/components/ui/dialog.tsx"].flatMap(file=>["--file",file])],{root:path.join(checkout,"apps/desktop"),config:reactPath});
 await native("near-duplicates",["dupes","src/components","--mode","semantic","--near","--min-occurrences","3","--top","12","--no-fragments"],{root:path.join(checkout,"apps/desktop")});
 await native("css-token-consumers",["health","--css","--report-only"],{root:path.join(checkout,"apps/desktop")});
 const fixture=path.join(evidence,"node-fixture");mkdirSync(fixture,{recursive:true});
 const copied=["scripts/runtime-values.mts","scripts/check-fallow-report.mts","scripts/check-fallow-report.test.mts","scripts/fallow-test-fixture.mts"].map(f=>copyBaseline(f,fixture));
 writeFileSync(path.join(fixture,"package.json"),JSON.stringify({name:"portcove-bounded-native-trial",private:true,type:"module"}));
 writeFileSync(path.join(fixture,".gitignore"),".fallow/\nnode_modules/\n");
 writeFileSync(path.join(fixture,".fallowrc.json"),JSON.stringify({entry:["scripts/*.test.mts"],mutation:{runner:"node-test",concurrency:1}}));
 initFixture(fixture);writeFileSync(path.join(evidence,"node-fixture-source.json"),JSON.stringify({baseline,files:copied,fixture_head:git(["rev-parse","HEAD"],fixture),scope:"Exact maintained source/test bytes from baseline; isolated fixture, no full repository test claim."},null,2));
 const nodePlan=await native("node-mutation-plan",["mutation","--plan","scripts/runtime-values.mts","--max-mutants","3","--concurrency","1"],{root:fixture});
 const coverage=path.join(evidence,"node-v8-coverage");mkdirSync(coverage,{recursive:true});
 const baselineRun=await command("node-fixture-coverage",["--test","scripts/check-fallow-report.test.mts"],{cwd:fixture,timeout:30000,environment:{...env,NODE_V8_COVERAGE:coverage}});
 if(baselineRun.item.status===0){
   const healthArgs=["health","--complexity","--file-scores","--max-cyclomatic","1","--max-cognitive","1","--max-crap","1"];
   await native("fixture-health-estimated",healthArgs,{root:fixture});
   await native("fixture-health-measured",[...healthArgs,"--coverage",coverage],{root:fixture});
   if(inspectPlan("node-mutation-plan",nodePlan,"scripts/runtime-values.mts",3)) await native("node-mutation-run",["mutation","scripts/runtime-values.mts","--max-mutants","3","--concurrency","1","--time-budget","40s","--setup-timeout","15s","--runtime",node],{root:fixture,timeout:60000});
 }
 writeFileSync(path.join(evidence,"node-fixture-after.json"),JSON.stringify({status:git(["status","--porcelain","--untracked-files=all"],fixture),source_hashes:copied.map(f=>({path:f.path,sha256:hash(readFileSync(path.join(fixture,f.path)))}))},null,2));
 const viteFixture=path.join(evidence,"vite-fixture");mkdirSync(viteFixture,{recursive:true});
 const viteCopied=["apps/desktop/src/shared/concurrency-state.ts","apps/desktop/src/shared/concurrency-state.test.ts"].map(f=>copyBaseline(f,viteFixture));
 writeFileSync(path.join(viteFixture,"package.json"),JSON.stringify({name:"portcove-bounded-vite-trial",private:true,type:"module",devDependencies:{vitest:JSON.parse(readFileSync(path.join(checkout,"apps/desktop/node_modules/vitest/package.json"),"utf8")).version,"vite-plus":JSON.parse(readFileSync(path.join(checkout,"apps/desktop/node_modules/vite-plus/package.json"),"utf8")).version}}));
 writeFileSync(path.join(viteFixture,".gitignore"),".fallow/\nnode_modules/\n");
 writeFileSync(path.join(viteFixture,".fallowrc.json"),JSON.stringify({entry:["apps/desktop/src/shared/*.test.ts"],mutation:{runner:"vitest",concurrency:1}}));
 writeFileSync(path.join(viteFixture,"vitest.config.mts"),'import {defineConfig} from "vitest/config"; export default defineConfig({test:{include:["apps/desktop/src/shared/concurrency-state.test.ts"],environment:"node",maxWorkers:1}});\n');
 symlinkSync(path.join(checkout,"apps/desktop/node_modules"),path.join(viteFixture,"node_modules"),process.platform==="win32"?"junction":"dir");
 initFixture(viteFixture);
 writeFileSync(path.join(evidence,"vite-fixture-source.json"),JSON.stringify({baseline,files:viteCopied,fixture_head:git(["rev-parse","HEAD"],viteFixture),dependencies:"Existing maintained apps/desktop/node_modules symlink; no installation",scope:"Exact maintained Vite+ imports/tests on isolated fixture."},null,2));
 const vitePlan=await native("vite-mutation-plan",["mutation","--plan","apps/desktop/src/shared/concurrency-state.ts","--max-mutants","2","--concurrency","1"],{root:viteFixture});
 if(inspectPlan("vite-mutation-plan",vitePlan,"apps/desktop/src/shared/concurrency-state.ts",2)) await native("vite-mutation-run",["mutation","apps/desktop/src/shared/concurrency-state.ts","--max-mutants","2","--concurrency","1","--time-budget","40s","--setup-timeout","15s","--runtime",node],{root:viteFixture,timeout:60000});
 writeFileSync(path.join(evidence,"vite-fixture-after.json"),JSON.stringify({status:git(["status","--porcelain","--untracked-files=all"],viteFixture),source_hashes:viteCopied.map(f=>({path:f.path,sha256:hash(readFileSync(path.join(viteFixture,f.path)))}))},null,2));
 writeFileSync(path.join(evidence,"complete.json"),JSON.stringify({completed_at:new Date().toISOString(),commands:results.length,baseline,source_edit_authority:"Disposable fixture only",observations_only:true,git_status:git(["status","--porcelain","--untracked-files=all"]),baseline_integrity:copied.every(f=>hash(readFileSync(path.join(fixture,f.path)))===f.sha256)&&viteCopied.every(f=>hash(readFileSync(path.join(viteFixture,f.path)))===f.sha256)},null,2));
 return 0;
}
const {resourceEntrypoint}=await import(pathToFileURL(path.join(checkout,"scripts/resource-command.mts")));
process.exitCode=await resourceEntrypoint("analysis",trials,{cwd:checkout});

