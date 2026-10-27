/** Controlled provider composition only; never actual signing/native evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hostedNativeProofFixture } from "./fixtures/hosted-native-proof-fixture.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";

for (const platform of ["linux-x86_64", "windows-x86_64"] as const)
  for (const proofStage of ["payload-signing", "release-publication"] as const)
    void test(`original hosted ${platform} ${proofStage} proof signs exact capture once and retains refusal/ambiguity/custody effects`, async (t) => {
      const root = disposableDirectory(t, path.join(os.tmpdir(), "hosted-proof-producer-"));
      const fixture = hostedNativeProofFixture(platform, proofStage);
      await writeFile(
        path.join(root, "fixture.json"),
        JSON.stringify({
          root,
          platform,
          authorities: fixture.authorities,
          producer: fixture.producer,
          report: fixture.report,
          request: fixture.request,
          host: fixture.host,
          files: Object.fromEntries(
            Object.entries(fixture.files).map(([key, bytes]) => [key, bytes.toString("base64")]),
          ),
        }),
      );
      const entry = new URL("./release-hosted-native-proof-producer.mts", import.meta.url).href;
      const code = String.raw`
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync(process.argv[1],'utf8'));
process.env.GH_TOKEN='inert-fixed-job-reader-token';
const files=Object.fromEntries(Object.entries(f.files).map(([key,value])=>[key,Buffer.from(value,'base64')]));
const inertToken='eyJhbGciOiJSUzI1NiJ9.'+Buffer.from(JSON.stringify({sub:'inert-native-subject'})).toString('base64url')+'.aW5lcnQ';
let directory, reportReceipt, fault='', posts=0, stale=false, parentReceipt={}, identityRequests=0, clock=1000, delayed=false;
Object.defineProperty(performance,'now',{value:()=>clock});
const realNow=Date.now;
let wall=realNow();Date.now=()=>wall;
const requests=[];
const parent=()=>{if(stale)throw Error('original custody expired');return {platform_label:f.platform,stage:f.report.stage,configuration:f.authorities,producer:f.producer,deadline:performance.now()+110000}};
const host=f.platform==='windows-x86_64'?{schema_version:1,nonce:'c'.repeat(64),architecture:'x86_64',machine_id_sha256:f.host.machine_id_sha256,broker_sid:f.host.account.broker,os:{caption:'Microsoft Windows 11 Pro',version:f.report.host.os_version,product_type:1,display_version:'26H2',build_number:'26200'}}:{schema_version:1,invocation_id:f.report.producer.invocation_id,qualification_uid:Number(f.host.account.qualification),qualification_gid:1002,machine_id_sha256:f.host.machine_id_sha256,os_release:'ID=ubuntu\nVERSION_ID="24.04"\n',kernel_release:f.report.host.os_version,architecture:'x86_64',authority:'none'};
globalThis.fixture={
 report:async value=>{assert.equal(value,reportReceipt);parent();if(fault==='postsign')throw Error('post-sign held');if(fault==='delayed-input'&&!delayed){clock+=120001;delayed=true}return {directory,report:f.report,original_file_identities:['report','capture'].map(key=>({name:key==='report'?'native-report.json':'capture.json',bytes:files[key].length,sha256:createHash('sha256').update(files[key]).digest('hex')})),prepared:{request:{invocation_id:host.invocation_id}},actual:{parent:parentReceipt,parent_source:parentReceipt,hostNonce:'c'.repeat(64),host:{projection:f.host,observed:host}}}},
 parent:async value=>{assert.equal(value,parentReceipt);return parent()},
 token:async audience=>{identityRequests++;assert.equal(audience,'sigstore');return inertToken},
 identity:async(platform,token,expected)=>{assert.equal(platform,f.platform);assert.equal(token,inertToken);assert.equal(expected.audience,'sigstore');return {job_id:fault==='wrong-job'?999:f.producer.job_id,check_run_id:f.producer.check_run_id,evidence_scope:'github.com',expires_at:new Date(Date.now()+(fault==='clock-expiry'?1000:100000)).toISOString()}},
 store:async dir=>{mkdirSync(dir);if(fault==='delayed-store')clock+=120001;return {write:async(name,bytes)=>{writeFileSync(path.join(dir,name),bytes,{flag:'wx',mode:0o600});if(fault==='clock-expiry'&&name==='identity.json'){clock+=1001;wall-=100000}}}},
 read:async(dir,name)=>{const p=path.join(dir,name);const bytes=readFileSync(p);if(fault==='swapped-report'&&name==='native-report.json'){writeFileSync(p,Buffer.concat([bytes,Buffer.from(' ')]));const swapped=readFileSync(p);writeFileSync(p,bytes);return swapped}return bytes},
};
globalThis.fixture.windowsStore=async dir=>{assert.equal(f.platform,'windows-x86_64');if(fault==='store-refused')throw Error('Windows store refused');return globalThis.fixture.store(dir)};
globalThis.fetch=async(url,options)=>{
 posts++;requests.push({url,body:options.body});if(fault==='ambiguous')throw Error('lost provider response');if(fault==='late-rekor'&&posts===1)stale=true;
 const body=JSON.parse(Buffer.from(options.body).toString());
 if(url==='https://fulcio.sigstore.dev/api/v2/signingCert'){
  assert.equal(body.credentials.oidcIdentityToken,inertToken);
  return new Response(JSON.stringify({signedCertificateEmbeddedSct:{chain:{certificates:['-----BEGIN CERTIFICATE-----\naW5lcnQtY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----']}}}),{status:201,headers:{'content-type':'application/json'}});
 }
 assert.equal(url,'https://rekor.sigstore.dev/api/v1/log/entries');
 return new Response(JSON.stringify({fixture:{body:Buffer.from(JSON.stringify(body)).toString('base64'),integratedTime:Math.floor(Date.now()/1000),logID:'a'.repeat(64),logIndex:1,verification:{signedEntryTimestamp:'aW5lcnQ='}}}),{status:201,headers:{'content-type':'application/json'}});
};
const modules={
 './release-native-pre-sign-report.mts':{requireActualHostedWindowsNativeStageReport:'report'},
 './release-owned-windows-proof-store.mts':{createHostedWindowsNativeProofStore:'windowsStore'},
 './release-native-linux-report.mts':{requireActualHostedLinuxNativeStageReport:'report'},
 './release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},
 './release-owned-capture-store.mts':{createHostedNativeProofStore:'store'},
 './release-public-build-inputs.mts':{readBoundedPublicBuildInputFile:'read'},
};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&modules[specifier])return {url:'inert-proof:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url===${JSON.stringify(entry)}&&f.platform==='windows-x86_64')return {format:'module-typescript',source:readFileSync(new URL(url),'utf8').replace('export const hostedWindowsProofExecutionAuthorized = false;','export const hostedWindowsProofExecutionAuthorized = true;'),shortCircuit:true};if(url.startsWith('inert-proof:')){const m=modules[url.slice('inert-proof:'.length)];return {format:'module',source:Object.entries(m).map(([name,fn])=>'export const '+name+'=globalThis.fixture.'+fn+';').join('\n'),shortCircuit:true}}return next(url,context)}});
// Keep the real profile helpers; substitute only credential acquisition and live identity observation.
const identityURL=new URL('./assembler-job-identity.mts',${JSON.stringify(entry)}).href;
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(entry)}&&specifier==='./assembler-job-identity.mts')return {url:'inert-proof-identity:',shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url==='inert-proof-identity:')return {format:'module',source:'export {hostedNativeJobProfile,controllerOidcSubject} from '+JSON.stringify(identityURL)+';export const requestAssemblerToken=globalThis.fixture.token;export const verifyHostedNativeAttestationIdentity=globalThis.fixture.identity;',shortCircuit:true};return next(url,context)}});
const api=await import(${JSON.stringify(entry)});
const sign=f.platform==='windows-x86_64'?api.signActualHostedWindowsNativeProof:api.signActualHostedLinuxNativeProof,get=f.platform==='windows-x86_64'?api.requireActualHostedWindowsNativeProof:api.requireActualHostedLinuxNativeProof;
const reset=name=>{fault=name;posts=0;stale=false;identityRequests=0;clock=1000;wall=realNow();delayed=false;reportReceipt={};parentReceipt={};directory=path.join(f.root,name||'valid');mkdirSync(directory);for(const key of ['report','capture'])writeFileSync(path.join(directory,key==='report'?'native-report.json':'capture.json'),files[key]);writeFileSync(path.join(directory,'host-before.stdout.bin'),JSON.stringify(host))};
reset('');
const receipt=await sign(reportReceipt);
assert.equal(posts,2);
const got=await get(receipt);
assert.equal(got.signature_verification,'not-performed');
assert.equal(got.artifact_name,'hosted-native-'+f.report.stage+'-'+f.platform+'-9988-1');
assert.ok(got.files.report.equals(files.report));
await assert.rejects(sign(reportReceipt),/recovery/);
assert.equal(posts,2);
await assert.rejects(get({...receipt}),/original/);
got.files.bundle.fill(0);
assert.notEqual((await get(receipt)).files.bundle[0],0);
const bundlePath=path.join(directory,'hosted-proof/bundle.json');
const bundle=readFileSync(bundlePath);writeFileSync(bundlePath,'{}');
await assert.rejects(get(receipt));writeFileSync(bundlePath,bundle);
await assert.rejects(get(receipt),/original/);
for(const name of ['wrong-job','late-rekor','ambiguous','postsign']){
 reset(name);
 await assert.rejects(sign(reportReceipt));
 assert.equal(posts,name==='wrong-job'||name==='postsign'?0:1);
 if(name==='postsign')continue;
 const failure=JSON.parse(readFileSync(path.join(directory,'hosted-proof/signing-failure.json')));
 assert.equal(failure.automatic_retry,false);assert.equal(failure.recovery_required,true);
 assert.equal(failure.remote_effect,name==='wrong-job'?'not-attempted':'unknown');
 assert.ok(existsSync(path.join(directory,'hosted-proof/signing-intent.json')));
 stale=false;await assert.rejects(sign(reportReceipt),/recovery/);
}
if(f.platform==='windows-x86_64'){reset('store-refused');await assert.rejects(sign(reportReceipt),/Windows store refused/);assert.equal(posts,0);assert.equal(identityRequests,0)}
for(const name of ['swapped-report','delayed-input','delayed-store','clock-expiry']){
 reset(name);await assert.rejects(sign(reportReceipt));
 assert.equal(posts,0);
 assert.equal(identityRequests,name==='clock-expiry'?1:0);
 if(name==='swapped-report')assert.ok(readFileSync(path.join(directory,'native-report.json')).equals(files.report));
 const requestsBefore=identityRequests;fault='';
 await assert.rejects(sign(reportReceipt),/recovery/);
 assert.equal(posts,0);assert.equal(identityRequests,requestsBefore);
}
console.log(JSON.stringify({controlled_composition:'passed',actual_signing_or_native_acceptance:false}));
`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", code, path.join(root, "fixture.json")],
        { encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /"controlled_composition":"passed"/u);
    });
