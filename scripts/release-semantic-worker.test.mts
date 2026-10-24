import { capacityDigest } from "./release-capacity.mts";
import { createCatalogReviewRequest } from "./release-catalog-review-request.mts";
import { reviewFrozenCatalogCoordinatorRequest } from "./release-semantic-request-pipeline.mts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectSemanticWorkerConfiguration,
  inspectSemanticSetupProbeConfiguration,
  inspectSemanticWorkerEntryConfiguration,
  claimSemanticSetupProbe,
  renderSemanticWorkerUnits,
} from "./release-semantic-worker.mts";
import { inspectLinuxQualificationSettlement } from "./qualify-semantic-linux.mts";
import { renderSemanticWslWorkerTask } from "./release-local-worker-tasks.mts";
import { createHash } from "node:crypto";
import { reviewFrozenCoordinatorRequest } from "./release-semantic-request-pipeline.mts";
import { releaseSourceFixture } from "./fixtures/release-source-fixture.mts";
import { inspectRemoteCommitObject } from "./release-coordinator-recovery.mts";
import { createReleaseReviewRequest } from "./release-review-request.mts";
import {
  claimSemanticTechnicalAttempt,
  inspectSemanticTechnicalRecovery,
} from "./release-semantic-worker-recovery.mts";

void test("technical recovery permits failed auth only after retained teardown plus current exact empty unit; never acceptance", () => {
  const stopped = {
    schema_version: 1,
    mode: "codex",
    scope: "held-linux-semantic-runtime-preparation",
    authority: "none",
    unit: `portcove-semantic-${"a".repeat(32)}.service`,
    cgroup_empty: true,
    unit_settled: true,
    network_settled: true,
    cleanup_errors: [],
    auth_refreshed: false,
    exit_code: 1,
    failure: "explicit authentication refusal",
  };
  const current = {
    MainPID: "0",
    ControlGroup: "",
    LoadState: "not-found",
    ActiveState: "inactive",
  };
  assert.equal(inspectSemanticTechnicalRecovery(stopped, current).scope, "technical recovery only");
  for (const change of [
    { cgroup_empty: false },
    { network_settled: false },
    { unit: "foreign.service" },
    { cleanup_errors: ["unknown"] },
  ])
    assert.throws(() => inspectSemanticTechnicalRecovery({ ...stopped, ...change }, current));
  for (const change of [
    { MainPID: "123" },
    { ControlGroup: "/live" },
    { LoadState: "loaded", ActiveState: "active" },
  ])
    assert.throws(() => inspectSemanticTechnicalRecovery(stopped, { ...current, ...change }));
});

void test("persistent technical exclusion resumes pre-launch failure twice, retains originals and refuses budget/reset/POST ambiguity", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-technical-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const request = path.join(parent, "request-fixed");
  await mkdir(request);
  for (let index = 0; index < 3; index++) {
    const current = await claimSemanticTechnicalAttempt(request, "a".repeat(64));
    assert.equal(path.basename(current), `technical-${index}`);
    await assert.rejects(claimSemanticTechnicalAttempt(request, "a".repeat(64)));
    await writeFile(
      path.join(current, "technical-stop.json"),
      JSON.stringify({ outcome: "technical-failure", invocations: [] }),
    );
  }
  await assert.rejects(claimSemanticTechnicalAttempt(request, "a".repeat(64)), /budget exhausted/);
  await rm(path.join(request, "technical-2"), { recursive: true });
  await assert.rejects(claimSemanticTechnicalAttempt(request, "a".repeat(64)), /custody missing/);
  const another = path.join(parent, "request-post");
  await mkdir(another);
  const first = await claimSemanticTechnicalAttempt(another, "a".repeat(64));
  await writeFile(
    path.join(first, "technical-stop.json"),
    JSON.stringify({ outcome: "technical-failure", invocations: [] }),
  );
  await writeFile(path.join(first, "expected-check.json"), "original");
  await assert.rejects(claimSemanticTechnicalAttempt(another, "a".repeat(64)), /GET-only/);
});

function configuration() {
  return {
    schema_version: 1,
    kind: "portcove-fixed-semantic-worker",
    worker_revision: "a".repeat(40),
    setup_grant_sha256: "1".repeat(64),
    namespace: "portcove-worker-fixture",
    output_parent: "/unprovisioned/output",
    source_repository: "/unprovisioned/source",
    source_git_sha256: "d".repeat(64),
    source_read_token: "/unprovisioned/credentials/source-read",
    auth_cache: "/unprovisioned/reviewer/auth.json",
    runtime: {
      schema_version: 1,
      output_parent: "/unprovisioned/output",
      node_executable: "/unprovisioned/node",
      codex_executable: "/unprovisioned/codex",
      node_sha256: "2".repeat(64),
      codex_sha256: "3".repeat(64),
      supervisor_sha256: "4".repeat(64),
      tools_sha256: {
        python: "5".repeat(64),
        bwrap: "6".repeat(64),
        systemd_run: "7".repeat(64),
        systemctl: "8".repeat(64),
      },
    },
    issuer: {
      issuer: { app_id: 123, installation_id: 456, writer_app_id: 789 },
      private_key: "/unprovisioned/issuer/private.pem",
      public_key_sha256: "9".repeat(64),
      node_sha256: "2".repeat(64),
      http_modules_sha256: {
        "release-semantic-issuer-http.mts": "a".repeat(64),
        "release-canonical.mts": "b".repeat(64),
        "runtime-values.mts": "c".repeat(64),
      },
    },
  };
}
function selectedConfiguration() {
  const prior = configuration();
  return {
    ...prior,
    schema_version: 2,
    issuer: { ...prior.issuer, issuer: { schema_version: 2, app_id: 123, installation_id: 456 } },
  };
}
void test("selected semantic worker needs only the independent issuer and refuses mixed schema or a phantom writer", () => {
  const prior = configuration();
  const raw = selectedConfiguration();
  const config = inspectSemanticWorkerConfiguration(raw);
  assert.equal("writer_app_id" in config.issuer.issuer, false);
  assert.equal(
    renderSemanticWorkerUnits(raw, "/owned/config.json", "a".repeat(64), "/owned/controller")
      .initial_state.worker_revision,
    raw.worker_revision,
  );
  for (const bad of [
    { ...raw, schema_version: 1 },
    { ...raw, schema_version: "2" },
    { ...raw, issuer: prior.issuer },
    { ...prior, issuer: raw.issuer },
    { ...raw, issuer: { ...raw.issuer, issuer: { ...raw.issuer.issuer, writer_app_id: 789 } } },
    { ...raw, issuer: { ...raw.issuer, issuer: { ...raw.issuer.issuer, app_id: 15368 } } },
  ])
    assert.throws(() => inspectSemanticWorkerConfiguration(bad));
});
void test("worker setup excludes supplied outcomes/backends and separates the fixed issuer from source/reviewer inputs", () => {
  const raw = configuration();
  const result = inspectSemanticWorkerConfiguration(raw);
  assert.equal(result.namespace, raw.namespace);
  assert.notEqual(result.source_read_token, result.issuer.private_key);
  const units = renderSemanticWorkerUnits(
    raw,
    "/owned/config.json",
    "a".repeat(64),
    "/owned/controller",
  );
  assert.match(units.service, /Type=oneshot/u);
  assert.match(units.service, /Restart=no/u);
  assert.match(units.service, /KillMode=control-group/u);
  assert.match(units.timer, /OnUnitInactiveSec=5min/u);
  assert.equal(units.initial_state.setup_grant_sha256, raw.setup_grant_sha256);
  assert.throws(() =>
    renderSemanticWorkerUnits(raw, "/owned/%h.json", "a".repeat(64), "/owned/controller"),
  );
  for (const changed of [
    { ...raw, accepted: true },
    { ...raw, source_read_token: "ambient" },
    { ...raw, source_read_token: raw.auth_cache },
    { ...raw, source_read_token: `${raw.output_parent}/source-token` },
    { ...raw, source_read_token: "/unprovisioned/./credentials/source-read" },
    { ...raw, runtime: { ...raw.runtime, backend: "return-accepted" } },
    { ...raw, issuer: { ...raw.issuer, issuer: { ...raw.issuer.issuer, app_id: 15368 } } },
    { ...raw, issuer: { ...raw.issuer, issuer: { ...raw.issuer.issuer, app_id: 789 } } },
    { ...raw, issuer: { ...raw.issuer, node_sha256: "d".repeat(64) } },
  ])
    assert.throws(() => inspectSemanticWorkerConfiguration(changed));
});

function probeConfiguration() {
  const normal = configuration();
  return {
    schema_version: 1,
    kind: "portcove-initial-semantic-boundary-probe",
    initial_setup_probe: true,
    worker_revision: normal.worker_revision,
    setup_grant_sha256: normal.setup_grant_sha256,
    source_git_sha256: normal.source_git_sha256,
    output_parent: normal.output_parent,
    runtime: normal.runtime,
  };
}
void test("cold-start probe is a closed credential-free entry union through the same fixed Task and service", async () => {
  const raw = probeConfiguration();
  assert.equal(inspectSemanticSetupProbeConfiguration(raw).initial_setup_probe, true);
  assert.ok("initial_setup_probe" in inspectSemanticWorkerEntryConfiguration(raw));
  assert.ok(!("initial_setup_probe" in inspectSemanticWorkerEntryConfiguration(configuration())));
  for (const extra of [
    { issuer: configuration().issuer },
    { auth_cache: configuration().auth_cache },
    { source_read_token: configuration().source_read_token },
    { mode: "codex-fixture" },
    { accepted: true },
    { initial_setup_probe: false },
  ])
    assert.throws(() => inspectSemanticSetupProbeConfiguration({ ...raw, ...extra }));
  assert.throws(() =>
    inspectSemanticWorkerEntryConfiguration({ ...configuration(), initial_setup_probe: true }),
  );
  const json = JSON.stringify(raw),
    sha = createHash("sha256").update(json).digest("hex");
  const task = await renderSemanticWslWorkerTask({
    broker_sid: "S-1-5-21-1-2-3-1001",
    system_root: "C:\\Windows",
    distribution: "Ubuntu-24.04",
    username: "portcove-review",
    controller: "/owned/controller",
    configuration: "/owned/semantic-setup-probe.json",
    configuration_json: json,
    configuration_sha256: sha,
    start_utc: "2026-10-21T00:00:00.000Z",
  });
  assert.equal(
    task.action.arguments,
    "--distribution Ubuntu-24.04 --user portcove-review --exec /usr/bin/systemctl --user start --wait portcove-semantic-worker.service",
  );
  assert.match(
    task.linux_service,
    /release-semantic-worker[.]mts \/owned\/semantic-setup-probe[.]json/u,
  );
  assert.equal(task.linux_initial_state.kind, "portcove-semantic-setup-probe-custody");
  assert.equal(task.timer_enabled, false);
  assert.equal(task.initial_enabled, false);
  assert.throws(
    () => renderSemanticWorkerUnits(raw, "/owned/semantic.json", sha, "/owned/controller"),
    /fixed configuration basename/u,
  );
});
void test("one fixed setup-probe claim retains the original and refuses concurrent, changed or failed repeats", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "semantic-probe-claim-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const identity = {
    configuration_sha256: "a".repeat(64),
    setup_grant_sha256: "b".repeat(64),
    worker_revision: "c".repeat(40),
  };
  const results = await Promise.allSettled([
    claimSemanticSetupProbe(parent, identity),
    claimSemanticSetupProbe(parent, identity),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const directory = path.join(parent, "initial-setup-probe");
  const original = await readFile(path.join(directory, "claim.json"));
  await writeFile(path.join(directory, "probe-refusal.json"), "retained refusal\n");
  await assert.rejects(
    claimSemanticSetupProbe(parent, { ...identity, configuration_sha256: "d".repeat(64) }),
  );
  assert.deepEqual(await readFile(path.join(directory, "claim.json")), original);
});
void test("probe settlement requires the existing positive fixture teardown and cannot establish semantic/native acceptance", () => {
  const isolation = {
    mode: "fixture",
    authority: "none",
    cgroup_verified: true,
    namespaces_verified: true,
    capture_complete: true,
    cgroup_empty: true,
    unit_settled: true,
    network_settled: true,
    network_refused: false,
    forced_termination: false,
    failure: null,
    auth_refreshed: false,
    exit_code: 0,
    cleanup_errors: [],
  };
  assert.equal(
    inspectLinuxQualificationSettlement(0, isolation, "fixture").semantic_acceptance,
    false,
  );
  for (const changed of [
    { mode: "codex" },
    { cgroup_empty: false },
    { unit_settled: false },
    { network_settled: false },
    { auth_refreshed: true },
    { forced_termination: true },
    { cleanup_errors: ["unknown"] },
    { exit_code: null },
  ])
    assert.throws(() =>
      inspectLinuxQualificationSettlement(0, { ...isolation, ...changed }, "fixture"),
    );
  assert.throws(() => inspectLinuxQualificationSettlement(1, isolation, "fixture"));
});
void test("actual worker entry dispatches the initial probe before all credential paths, under controlled modules only", () => {
  const worker = new URL("./release-semantic-worker.mts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict'; import {registerHooks} from 'node:module'; import {createHash} from 'node:crypto';
    const sha=x=>createHash('sha256').update(x).digest('hex');
    const worker=${JSON.stringify(worker)};
    const runtime={schema_version:1,output_parent:'/private/output',node_executable:'/private/node',codex_executable:'/private/codex',node_sha256:sha('node'),codex_sha256:'3'.repeat(64),supervisor_sha256:'4'.repeat(64),tools_sha256:{python:'5'.repeat(64),bwrap:'6'.repeat(64),systemd_run:'7'.repeat(64),systemctl:'8'.repeat(64)}};
    const config={schema_version:1,kind:'portcove-initial-semantic-boundary-probe',initial_setup_probe:true,worker_revision:'a'.repeat(40),setup_grant_sha256:'b'.repeat(64),source_git_sha256:sha('git'),output_parent:runtime.output_parent,runtime};
    const raw=Buffer.from(JSON.stringify(config)), hash=sha(raw), files=new Map(), dirs=new Set(); let launches=0;
    const state={schema_version:1,kind:'portcove-semantic-setup-probe-custody',configuration_sha256:hash,setup_grant_sha256:config.setup_grant_sha256,worker_revision:config.worker_revision};
    const isolation={mode:'fixture',authority:'none',cgroup_verified:true,namespaces_verified:true,capture_complete:true,cgroup_empty:true,unit_settled:true,network_settled:true,network_refused:false,forced_termination:false,failure:null,auth_refreshed:false,exit_code:0,cleanup_errors:[]};
    globalThis.__probe={
      async lstat(p){return {uid:1000,mode:p.endsWith('.json')?0o100600:0o40700,nlink:1,isSymbolicLink:()=>false,isFile:()=>true,isDirectory:()=>true};},
      async mkdir(p){if(dirs.has(p))throw Object.assign(new Error('exists'),{code:'EEXIST'});dirs.add(p);},
      async open(p,flags){assert.equal(flags,'wx');assert.ok(!files.has(p));return {async writeFile(v){files.set(p,String(v));},async sync(){},async close(){}};},
      async readdir(){return [{name:'q-fixed1',isDirectory:()=>true,isSymbolicLink:()=>false}];},
      async read(root,name){if(name==='semantic-setup-probe.json')return raw;if(name==='worker-state.json')return Buffer.from(JSON.stringify(state));if(root==='/usr/bin'&&name==='git')return Buffer.from('git');if(name==='isolation.json')return Buffer.from(JSON.stringify(isolation));if(name==='node'||name.endsWith('node.exe'))return Buffer.from('node');throw new Error('Unexpected read '+root+'/'+name);},
      git(_name,args){return args.includes('rev-parse')?'a'.repeat(40):'';},
      async resource(profile,node,args,options){launches++;assert.equal(profile,'analysis');assert.equal(node,runtime.node_executable);assert.equal(args[1],'fixture');assert.ok(args[0].endsWith('/scripts/qualify-semantic-linux.mts'));assert.ok(options.queueDeadline>performance.now());assert.equal(options.environment.GH_TOKEN,undefined);assert.equal(options.environment.OPENAI_API_KEY,undefined);return 0;}
    };
    const data=s=>'data:text/javascript,'+encodeURIComponent(s);
    registerHooks({resolve(spec,context,next){if(context.parentURL===worker){
      if(spec==='node:fs/promises')return {url:data('const p=globalThis.__probe; export const lstat=p.lstat,mkdir=p.mkdir,open=p.open,readdir=p.readdir; export const writeFile=()=>{throw new Error("no ordinary worker write");};'),shortCircuit:true};
      if(spec==='node:child_process')return {url:data('export const execFileSync=(...a)=>globalThis.__probe.git(...a); export const spawnSync=()=>{throw new Error("no provider/issuer process");};'),shortCircuit:true};
      if(spec==='node:path')return {url:data('import {posix} from "node:path";export default posix;'),shortCircuit:true};
      if(spec==='./release-public-build-inputs.mts')return {url:data('export const readBoundedPublicBuildInputFile=(...a)=>globalThis.__probe.read(...a);'),shortCircuit:true};
      if(spec==='./resource-command.mts')return {url:data('export const runResourceCommand=(...a)=>globalThis.__probe.resource(...a);'),shortCircuit:true};
    }return next(spec,context);}});
    const m=await import(worker); Object.defineProperty(process,'platform',{value:'linux'}); process.getuid=()=>1000; process.env.GH_TOKEN='MUST_NOT_REACH_CHILD';process.env.OPENAI_API_KEY='MUST_NOT_REACH_CHILD';
    process.env.GITHUB_ACTIONS='true';
    await assert.rejects(m.runSemanticWorkerOnce('/private/semantic-setup-probe.json',hash),/ordinary dedicated Linux parent/);assert.equal(launches,0);
    delete process.env.GITHUB_ACTIONS;
    const output=await m.runSemanticWorkerOnce('/private/semantic-setup-probe.json',hash);
    assert.equal(output.decision,'initial-setup-probe-settled');assert.equal(output.semantic_acceptance,false);assert.equal(launches,1);assert.ok(files.has('/private/output/initial-setup-probe/probe-settlement.json'));
    await assert.rejects(m.runSemanticWorkerOnce('/private/semantic-setup-probe.json',hash),/exists/);assert.equal(launches,1);
  `,
    ],
    { encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
});

void test("actual proposal pipeline freezes real Git inputs then refuses an unqualified host/runtime before capture or issuer release", async (t) => {
  const f = releaseSourceFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "semantic-pipeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--bare", "--quiet", root], { windowsHide: true });
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync("git", ["-C", root, ...args], { input, windowsHide: true })
      .toString()
      .trim();
  for (const text of ["readme\n", "base\n", "source\n"])
    git(["hash-object", "-w", "--stdin"], text);
  const readme = git(["hash-object", "--stdin"], "readme\n");
  for (const blob of [f.oldBlob, f.newBlob])
    git(["mktree"], `100644 blob ${readme}\tREADME.md\n100644 blob ${blob}\tapp.rs\n`);
  for (const commit of [f.base, f.original])
    git(
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      inspectRemoteCommitObject(commit, commit.sha).object.bytes,
    );
  const raw = inspectSemanticWorkerConfiguration(selectedConfiguration());
  const request = createReleaseReviewRequest({
    before_checkpoint: "f".repeat(40),
    requested_at: "2026-01-01T00:00:00.000Z",
    base_commit: f.base.sha,
    base_version: "0.1.0-alpha.2",
    source_commit: f.original.sha,
    source_tree: f.sourceTree,
    change_set_sha256: f.expectedHash,
  });
  const release = {
    id: 1,
    draft: false,
    tag_name: "v0.1.0-alpha.2",
    published_at: "2026-01-01T00:00:00Z",
  };
  let reads = 0,
    guards = 0,
    handoffs = 0;
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      reads++;
      let body: unknown;
      let status = 200;
      if (endpoint === "repos/boburning/portcove")
        body = { id: 1354613114, full_name: "boburning/portcove" };
      else if (endpoint.includes("/releases?")) body = [release];
      else if (endpoint.endsWith("/releases/1")) body = release;
      else if (endpoint.includes("/git/ref/tags/v0.1.0-alpha.2"))
        body = { ref: "refs/tags/v0.1.0-alpha.2", object: { type: "commit", sha: f.base.sha } };
      else if (endpoint.includes("/git/ref/tags/portcove-worker-fixture-")) {
        body = { message: "Not Found" };
        status = 404;
      } else return f.api.request(method, endpoint);
      return { status, body, headers: new Map<string, string>() };
    },
  };
  const selected = {
    namespace: raw.namespace,
    issuer: raw.issuer,
    runtime: {
      ...raw.runtime,
      backend: "linux-rootless" as const,
      auth_cache: raw.auth_cache,
      requireIsolationReady: async () => {
        guards++;
      },
    },
    requireCurrentRequestAndProvisioning: async () => {
      guards++;
    },
    retainOriginalCheckRequest: async () => {
      handoffs++;
    },
  };
  await assert.rejects(
    reviewFrozenCoordinatorRequest(api, root, request, selected),
    /fixed ordinary Linux runtime|qualified runtime changed|ENOENT/,
  );
  assert.ok(reads > 0);
  assert.ok(guards >= 1);
  assert.equal(handoffs, 0);
  const files = new Map([
    ["definitions/index.json", Buffer.from('{"catalog_schema":2,"entries":[]}')],
  ]);
  const fileBytes = files.get("definitions/index.json")!;
  const entries = [
    {
      target: "definitions/index.json",
      bytes: fileBytes.length,
      sha256: createHash("sha256").update(fileBytes).digest("hex"),
    },
  ];
  const inspection = `${JSON.stringify({ publication_schema: 1, authority: "none", index_sha256: entries[0]!.sha256, files: entries, definitions: [], scope: "inert-managed-definition-publication-inspection" })}\n`;
  const catalog = createCatalogReviewRequest({
    before_checkpoint: "f".repeat(40),
    requested_at: "2026-01-01T00:00:00.000Z",
    core_inspection: inspection,
    opportunity: {
      kind: "catalog-publication",
      source_commit: f.original.sha,
      source_tree: f.sourceTree,
      base_commit: f.base.sha,
      change_set_sha256: f.expectedHash,
      bundle_sha256: capacityDigest(entries),
      core_inspection_sha256: createHash("sha256").update(inspection).digest("hex"),
      publisher_configuration_sha256: "a".repeat(64),
      baseline: {
        source_commit: f.base.sha,
        source_tree: inspectRemoteCommitObject(f.base, f.base.sha).tree,
        catalog_root_sha256: "b".repeat(64),
        catalog_repository_sha256: null,
        site_generation_sha256: null,
        application_root_sha256: null,
        application_repository_sha256: null,
      },
      classification: { change: "initial", index_sha256: entries[0]!.sha256, definitions: [] },
      compatibility: {
        contract: "official-definition-policy-launch-v1",
        notes: "Controlled source fixture only, no actual semantic acceptance.",
      },
    },
  });
  reads = 0;
  await assert.rejects(
    reviewFrozenCatalogCoordinatorRequest(
      api,
      root,
      catalog,
      { files, prior_repository: null },
      selected,
    ),
    /fixed ordinary Linux runtime|qualified runtime changed|ENOENT/,
  );
  assert.ok(reads > 0);
  assert.equal(handoffs, 0);
  reads = 0;
  await assert.rejects(
    reviewFrozenCatalogCoordinatorRequest(
      api,
      root,
      catalog,
      { files, prior_repository: null },
      {
        ...selected,
        requireCurrentRequestAndProvisioning: async () => {
          throw new Error("catalog superseded");
        },
      },
    ),
    /catalog superseded/,
  );
  assert.equal(reads, 0);
  assert.equal(handoffs, 0);
  await assert.rejects(
    reviewFrozenCatalogCoordinatorRequest(
      api,
      root,
      catalog,
      {
        files: new Map([["definitions/index.json", Buffer.from("changed")]]),
        prior_repository: null,
      },
      selected,
    ),
    /catalog|inspection|hash|bytes/u,
  );
  assert.equal(handoffs, 0);
  reads = 0;
  await assert.rejects(
    reviewFrozenCoordinatorRequest(api, root, request, {
      ...selected,
      requireCurrentRequestAndProvisioning: async () => {
        throw new Error("request superseded");
      },
    }),
    /request superseded/,
  );
  assert.equal(reads, 0);
});
