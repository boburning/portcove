/** Process-local transport substitutions exercise composition, never actual
 * hosted/native/issuer observations or provider authority. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  nativeLinuxReportFixture,
  nativeLinuxPostSignReportFixture,
} from "./fixtures/native-linux-report-fixture.mts";
import { selectedPublicationAuthoritiesFixture } from "./fixtures/checkpoint-proof-fixture.mts";
import { prepareHostedNativeStageRequest } from "./release-native-stage-capture.mts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
for (const reportStage of ["pre", "initial", "update"] as const)
  void test(`hosted original ${reportStage} capture/report composition refuses failure, expired final checks and restored custody`, async (t) => {
    const root = disposableDirectory(t, path.join(os.tmpdir(), "hosted-linux-report-"));
    const fixture =
      reportStage === "pre"
        ? await nativeLinuxReportFixture()
        : await nativeLinuxPostSignReportFixture(reportStage === "initial");
    const authorities = selectedPublicationAuthoritiesFixture("application");
    assert.ok("hosted_native" in authorities);
    authorities.hosted_native["linux-x86_64"].producer = fixture.prepared.request.expected.producer;
    authorities.hosted_native["linux-x86_64"].compatibility = {
      required_capabilities: [],
      cli_protocol: fixture.base.source.cli_protocol,
      catalog_formats: [...fixture.base.source.catalog_formats],
      library: fixture.base.source.library,
      minimum_os_version: "24.04",
    };
    const projection = {
      machine_id_sha256: fixture.input.host.machine_id_sha256,
      qualification_profile: "fixed-hosted-native-v1",
      account: { kind: "linux-uid", broker: "1000", qualification: "1002" },
    };
    const prepared = prepareHostedNativeStageRequest(
      {
        schema_version: 1,
        stage: fixture.prepared.request.stage,
        platform_label: "linux-x86_64",
        candidate: fixture.prepared.request.candidate,
        journey: fixture.prepared.request.journey,
        invocation_id: fixture.prepared.request.invocation_id,
        setup_descriptor_sha256: authorities.journal.setup_plan_sha256,
      },
      authorities,
      projection,
    );
    const input = structuredClone(fixture.input);
    input.outer.stage_request_sha256 = prepared.request_sha256;
    input.driver.stage_request_sha256 = prepared.request_sha256;
    const capture = path.join(root, "capture");
    await mkdir(capture, { mode: 0o700 });
    const entries: { path: string; bytes: number; sha256: string }[] = [];
    const keep = async (name: string, value: unknown) => {
      const bytes =
        value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
      await mkdir(path.dirname(path.join(capture, name)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(capture, name), bytes, { mode: 0o600 });
      entries.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    };
    const publication =
      "publication" in input
        ? (input as Awaited<ReturnType<typeof nativeLinuxPostSignReportFixture>>["input"])
            .publication
        : null;
    if (publication)
      for (const [index, entry] of publication.entries.entries()) {
        const binding = {
          ...input.binding,
          application: { ...input.binding.application, ...entry.package },
        };
        const bindingBytes = Buffer.from(JSON.stringify(binding));
        entry.binding_sha256 = hash(bindingBytes);
        entry.runtime.binding_sha256 = entry.binding_sha256;
        const preferences = Buffer.from("inert retained preferences");
        entry.before_preferences_sha256 = index ? hash(preferences) : null;
        entry.after_preferences_sha256 = hash(preferences);
        entry.preferences_capture_sha256 = hash(preferences);
        await keep(`linux-binding-${entry.id}.json`, bindingBytes);
        await keep(`package-${entry.id}-replacement.json`, entry.replacement);
        await keep(`package-${entry.id}.preferences.bin`, preferences);
      }
    await keep("linux-binding.json", input.binding);
    await keep("outer-isolation.json", input.outer);
    await keep("linux-driver-result.json", {
      ...input.driver,
      ...(publication ? { package_lifecycle: publication.entries } : {}),
    });
    const observations = publication
      ? publication.entries
      : [{ id: "desktop", native: input.native, runtime: input.runtime, restart: input.restart }];
    for (const observation of observations) {
      await keep(`${observation.id}/evidence.json`, observation.native);
      await keep(`${observation.id}/linux-native-runtime.json`, observation.runtime);
      await keep(`${observation.id}/restart-observations.json`, observation.restart);
    }
    for (const [outputIndex, observation] of observations.entries()) {
      for (const index of [1, 2]) {
        const serial = outputIndex * 2 + index;
        const nonce = `${serial}0000000-0000-4000-8000-000000000000`,
          id = `namespace-${nonce.replaceAll("-", "")}`;
        const streams: Record<string, unknown> = { failed: false };
        for (const side of ["stdout", "stderr"]) {
          const bytes = side === "stdout" ? Buffer.from("inert namespace output") : Buffer.alloc(0);
          const name = `${id}.${side}.bin`;
          await keep(name, bytes);
          streams[side] = { path: name, bytes: bytes.length, sha256: hash(bytes) };
        }
        await keep(`${observation.id}/linux-native-launch-${index}-join.json`, {
          quiesced: true,
          protocol_error: null,
          nonce,
          exit: { code: 0, signal: null, observed_at: input.outer.completed_at },
          ready: {
            pid: 1,
            uid: input.binding.account.uid,
            process_identity: {
              pid: 1,
              image: input.binding.tools.python!.path,
              image_sha256: input.binding.tools.python!.sha256,
              creation_ticks: String(10000 + outputIndex * 600 + index),
              creation_clock: {
                realtime_ns: String(
                  BigInt(Date.parse(input.outer.started_at) + outputIndex * 6000 + 2000) * 1000000n,
                ),
                boottime_ns: String(102000000000n + BigInt(outputIndex * 6000) * 1000000n),
                ticks_per_second: 100,
                started_at: new Date(
                  Date.parse(input.outer.started_at) + outputIndex * 6000 + index * 10,
                ).toISOString(),
              },
            },
          },
          streams,
        });
      }
    }
    await keep("outer-stdout.log", Buffer.from("inert harness output"));
    await keep("outer-stderr.log", Buffer.alloc(0));
    const data = {
      prepared,
      authorities,
      projection,
      input,
      source: fixture.base.source,
      entries,
      root,
      capture,
    };
    await writeFile(path.join(root, "fixture.json"), JSON.stringify(data));
    const report = new URL("./release-native-linux-report.mts", import.meta.url).href;
    const code = String.raw`
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import path from 'node:path';
const fixture=JSON.parse(readFileSync(process.argv[1],'utf8'));
const captureReceipt={}, parentReceipt={}, candidateReceipt={};
let directory, failed=false, late=false, stopped=false, sourceReads=0, checks=0;
const check=()=>{checks++; if(stopped)throw Error('original expired');};
globalThis.hostedReportFixture={
 capture:async receipt=>{assert.equal(receipt,captureReceipt);check();return {
  actual:{parent_source:parentReceipt,candidate_receipt:candidateReceipt,host:{projection:fixture.projection}},
  directory,prepared:fixture.prepared,summary:{status:failed?1:0,failure:failed?'provider refusal':null},
  resource_status:failed?1:0,retained_capture:{directory:fixture.capture,entries:fixture.entries},
  capture_wire_sha256:'a'.repeat(64),
 }},
 parent:async receipt=>{assert.equal(receipt,parentReceipt);check();return {configuration:fixture.authorities,recheck:check}},
 candidate:async receipt=>{assert.equal(receipt,candidateReceipt);check();return {version:fixture.input.version,...(fixture.input.publication?{package_receipt:candidateReceipt,predecessor:fixture.prepared.request.journey.predecessor?{...fixture.prepared.request.journey.predecessor.package,version:fixture.input.publication.predecessor_version}:null,payload_crypto:fixture.input.publication.payload_cryptography}:{})}},
 source:async receipt=>{assert.equal(receipt,candidateReceipt);check();sourceReads++;if(late&&existsSync(path.join(directory,'native-report.json'))){stopped=true;throw Error('expired after final write');}return {declaration:fixture.source}},
 legacy:()=>{throw Error('legacy capture must remain separate')},
};
const modules={
 './release-hosted-native-linux-capture.mts':{requireActualHostedNativeLinuxCapture:'capture'},
 './release-hosted-native-parent.mts':{requireActualHostedNativeParentSource:'parent'},
 './release-hosted-native-candidate.mts':{requireActualHostedNativeCandidate:'candidate',readActualHostedNativeSourceDeclarations:'source',readActualHostedNativePostSignSourceDeclarations:'source'},
 './release-hosted-native-postsign-inputs.mts':{requireActualHostedNativePostSignPayload:'candidate'},
 './release-native-wsl-capture.mts':{requireActualWslNativeCapture:'legacy'},
 './release-native-candidate.mts':{readActualNativeSourceDeclarations:'legacy'},
};
registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(report)}&&modules[specifier])return {url:'inert-report:'+specifier,shortCircuit:true};return next(specifier,context)},load(url,context,next){if(url.startsWith('inert-report:')){const m=modules[url.slice('inert-report:'.length)];return {format:'module',source:Object.entries(m).map(([name,fn])=>'export const '+name+'=(...args)=>globalThis.hostedReportFixture.'+fn+'(...args);').join('\n'),shortCircuit:true}}return next(url,context)}});
const api=await import(${JSON.stringify(report)});
const prepare=async name=>{
 directory=path.join(fixture.root,name);mkdirSync(directory,{mode:0o700});
 writeFileSync(path.join(directory,'host-before.stdout.bin'),JSON.stringify(fixture.input.host));
 const publication=fixture.prepared.request.stage==='release-publication';const entry=publication?'candidate':'application';
 writeFileSync(path.join(directory,'stage-'+entry+'.stdout.bin'),JSON.stringify({invocation_id:fixture.prepared.request.invocation_id,entry,bytes:fixture.prepared.request.candidate.package.bytes,sha256:fixture.prepared.request.candidate.package.sha256,staged:true,authority:'none'}));
 if(publication&&fixture.prepared.request.journey.predecessor){const old=fixture.prepared.request.journey.predecessor.package;writeFileSync(path.join(directory,'stage-predecessor.stdout.bin'),JSON.stringify({invocation_id:fixture.prepared.request.invocation_id,entry:'predecessor',bytes:old.bytes,sha256:old.sha256,staged:true,authority:'none'}))}
 return api.prepareActualHostedLinuxNativeStageReport(captureReceipt);
};
const receipt=await prepare('valid');
assert.equal(api.isActualHostedLinuxNativeStageReport(receipt),true);
assert.equal(api.isActualLinuxNativeStageReport(receipt),false);
assert.equal((await api.requireActualHostedLinuxNativeStageReport(receipt)).report.host.account.kind,'linux-uid');
assert.ok(sourceReads>=4&&checks>=10);
await assert.rejects(api.requireActualLinuxNativeStageReport(receipt),/matching/);
await assert.rejects(api.requireActualHostedLinuxNativeStageReport({...receipt}),/matching/);
assert.equal(api.isActualHostedLinuxNativeStageReport(receipt),true);
const original=readFileSync(path.join(directory,'native-report.json'));
writeFileSync(path.join(directory,'native-report.json'),'{}');
await assert.rejects(api.requireActualHostedLinuxNativeStageReport(receipt));
writeFileSync(path.join(directory,'native-report.json'),original);
await assert.rejects(api.requireActualHostedLinuxNativeStageReport(receipt),/matching/);
assert.equal(api.isActualHostedLinuxNativeStageReport(receipt),false);
failed=true;await assert.rejects(prepare('failed'));
assert.equal(existsSync(path.join(directory,'native-report.json')),false);
failed=false;late=true;await assert.rejects(prepare('late'),/expired after final write/);
console.log(JSON.stringify({controlled_composition:'passed',actual_hosted_native_acceptance:false,sourceReads,checks}));
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", code, path.join(root, "fixture.json")],
      {
        encoding: "utf8",
        timeout: 45000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"controlled_composition":"passed"/u);
  });
