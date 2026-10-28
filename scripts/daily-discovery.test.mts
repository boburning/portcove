import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import {
  DiscoveryBudget,
  selectDiscoveryProfile,
  createDiscoveryTransport,
} from "./discovery-budget.mts";
import { boundedDiscoveryRequest } from "./discovery-http.mts";
import { boundedDiscoveryInput } from "./daily-discovery-session.mts";
import { readDiscoveryReport } from "./discovery-artifact.mts";
import { deflateRawSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoveryPost,
  recordDiscoveryComment,
  assertDiscoveryCommentMayPost,
} from "./discovery-mutation.mts";
import type { DiscoveryMutation } from "./discovery-mutation.mts";
import { GitHubApiError, GitHubApiClient } from "./github-api.mts";
import { renderPortIssueBody } from "./roadmap-issue.mts";
import { renameSync, readdirSync } from "node:fs";
import * as discoverySession from "./daily-discovery-session.mts";
import { discoveryBootstrapModules, fetchDiscoveryMetadata } from "./daily-discovery.mts";
const envelope = {
  url: "https://api.github.com/repos/o/r",
  method: "GET",
  cap: 1024,
  timeout: 1000,
  maxRequests: 5,
  token: "test-secret",
};
void test(
  "Windows reader sharing permits bounded atomic state replacement and preserves persistent failure",
  { skip: process.platform !== "win32", timeout: 10000 },
  async (t) => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    mkdirSync(path.join(root, "work"), { recursive: true });
    const state = mkdtempSync(path.join(root, "work/discovery-sharing-fixture-"));
    t.after(() => rmSync(state, { recursive: true, force: true }));
    const target = path.join(state, "budget.json");
    const script = path.join(state, "hold.ps1");
    writeFileSync(
      script,
      'param([string]$Target,[int]$Hold)\n$stream=[IO.File]::Open($Target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry { [Console]::Out.WriteLine("held"); Start-Sleep -Milliseconds $Hold } finally {$stream.Dispose()}',
    );
    for (const milliseconds of [300, 1800]) {
      writeFileSync(target, "old");
      const child = spawn("pwsh", ["-NoProfile", "-File", script, target, String(milliseconds)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      try {
        const signal: unknown[] = await once(child.stdout, "data");
        const ready = signal[0];
        assert.ok(Buffer.isBuffer(ready));
        assert.match(ready.toString("utf8"), /held/);
        const probe = path.join(state, "probe.next");
        writeFileSync(probe, "probe");
        assert.throws(() => renameSync(probe, target), { code: "EPERM" });
        const started = performance.now();
        if (milliseconds === 300) {
          // Exercise the production writer; old implementation fails at this same boundary.
          discoverySession.atomic(target, { requests: 134 });
          assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { requests: 134 });
        } else {
          assert.throws(() => discoverySession.atomic(target, { requests: 135 }), {
            code: "EPERM",
          });
          assert.equal(readFileSync(target, "utf8"), "old");
          const pending = readdirSync(state).find(
            (name) => name.startsWith("budget.json.") && name.endsWith(".next"),
          );
          assert.ok(pending);
          assert.deepEqual(JSON.parse(readFileSync(path.join(state, pending), "utf8")), {
            requests: 135,
          });
        }
        assert.ok(
          performance.now() - started < 1600,
          "state replacement must retain its finite wait",
        );
      } finally {
        assert.deepEqual(await exited, [0, null]);
      }
    }
  },
);
void test("bootstrap identity covers the complete statically loaded module closure", async () => {
  // The filtered Windows reader-sharing route runs before package installation.
  const { readFixtureModuleClosure } = await import("./fixtures/module-closure.mts");
  const entry = new URL("./daily-discovery.mts", import.meta.url);
  // The maintained production bootstrap list remains the independent expectation.
  // Later imports belong to the separately captured runner/execution inputs.
  const loaded = readFixtureModuleClosure(
    path.dirname(fileURLToPath(entry)),
    ["daily-discovery.mts"],
    {
      includeDynamicImports: false,
    },
  ).modules.map((module) => module.path);
  assert.deepEqual([...new Set(discoveryBootstrapModules)].sort(), loaded.sort());
});
void test("metadata fetch skips inherited graph writing and automatic maintenance", (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(path.join(root, "work"), { recursive: true });
  const state = mkdtempSync(path.join(root, "work/discovery-fetch-fixture-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const upstream = path.join(state, "upstream");
  const checkout = path.join(state, "checkout");
  mkdirSync(upstream);
  mkdirSync(checkout);
  const emptyConfig = path.join(state, "empty-config");
  writeFileSync(emptyConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("git", args, {
      cwd,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(upstream, ["init", "--initial-branch=main"]);
  git(upstream, ["commit", "--allow-empty", "-m", "fixture"]);
  git(checkout, ["init", "--initial-branch=main"]);
  git(checkout, ["remote", "add", "origin", upstream]);
  git(checkout, ["config", "fetch.writeCommitGraph", "true"]);
  git(checkout, ["config", "maintenance.auto", "true"]);
  const trace = path.join(state, "fetch-trace.jsonl");
  fetchDiscoveryMetadata((args) => git(checkout, args, { GIT_TRACE2_EVENT: trace }));
  assert.equal(git(checkout, ["rev-parse", "origin/main"]), git(upstream, ["rev-parse", "HEAD"]));
  const events = readFileSync(trace, "utf8");
  assert.doesNotMatch(events, /"label":"write-commit-graph"/u);
  assert.doesNotMatch(events, /"argv":\["git","maintenance"/u);
  assert.equal(git(checkout, ["config", "fetch.writeCommitGraph"]), "true");
});
void test("noninteractive run refuses before Git, credentials, inventory or lock acquisition", (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(path.join(root, "work"), { recursive: true });
  const state = mkdtempSync(path.join(root, "work/discovery-control-fixture-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    ["scripts/daily-discovery.mts", "run", "--state-dir", state],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      input: "",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tty:true/);
  assert.equal(existsSync(path.join(state, "investigation.lock")), false);
  assert.equal(existsSync(path.join(state, "active-run.json")), false);
  assert.match(readFileSync(path.join(state, "latest-startup.json"), "utf8"), /tty:true/);
});
void test("actual discovery startup consumes its bootstrap identities and bounded fetch", (t) => {
  const entry = new URL("./daily-discovery.mts", import.meta.url).href;
  const dependency = (name: string) => new URL(name, import.meta.url).href;
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  mkdirSync(work, { recursive: true });
  const state = mkdtempSync(path.join(work, "discovery-wiring-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  for (const variant of [
    "original",
    "renamed-reordered",
    "changed-bootstrap",
    "bypassed-fetch",
    "omitted-input",
    "removed-graph-guard",
    "removed-maintenance-guard",
  ]) {
    const program = `
      import assert from 'node:assert/strict';import {mock} from 'node:test';
      import {registerHooks} from 'node:module';import path from 'node:path';
      const entry=${JSON.stringify(entry)},state=${JSON.stringify(state)},variant=${JSON.stringify(variant)};
      const expected=${JSON.stringify([...discoveryBootstrapModules])};
      let fetched=false,checkedOut=false,sessions=0;const reads=new Map();
      Object.defineProperty(process.stdin,'isTTY',{value:true,configurable:true});
      mock.module('node:child_process',{namedExports:{execFileSync:(command,args)=>{
        assert.equal(command,'git');
        if(args[0]==='status'||args[0]==='branch')return '';
        if(args[0]==='fetch'){
          assert.deepEqual(args,['fetch','--no-write-commit-graph','--no-auto-maintenance','--no-tags','--no-recurse-submodules','origin','main']);
          assert.equal(reads.size,expected.length);for(const name of expected)assert.equal(reads.get(name),1);fetched=true;return '';
        }
        if(args[0]==='rev-parse')return args[1]==='--git-common-dir'?'/owned/common':args[1]==='--git-dir'?'/owned/common/worktrees/metadata':'a'.repeat(40);
        if(args[0]==='cat-file')return '';
        if(args[0]==='checkout'){assert.ok(fetched,'bounded fetch must precede checkout');checkedOut=true;return '';}
        throw Error('Unexpected Git call');
      }}});
      mock.module('node:fs/promises',{namedExports:{mkdir:async()=>{},writeFile:async(file)=>{assert.ok(file.startsWith(state+path.sep));},readFile:async(file)=>{
        const name=path.basename(file);assert.ok(expected.includes(name),'Unexpected bootstrap read');
        const count=(reads.get(name)||0)+1;reads.set(name,count);
        return Buffer.from(name+(variant==='changed-bootstrap'&&checkedOut&&name==='runtime-values.mts'?'changed':''));
      }}});
      mock.module(${JSON.stringify(dependency("./observe-configured-upstream.mts"))},{namedExports:{withCheckpointLock:async(file,body)=>{assert.equal(file,path.join(state,'investigation'));await body();}}});
      mock.module(${JSON.stringify(dependency("./release-path-safety.mts"))},{namedExports:{assertOwnedUnlinkedPath:async(parent,value)=>{assert.equal(value,state);return state;}}});
      mock.module(${JSON.stringify(dependency("./discovery-budget.mts"))},{namedExports:{selectDiscoveryProfile:()=>{throw Error('Unexpected profile selection');},discoveryProfiles:{}}});
      mock.module(${JSON.stringify(dependency("./discovery-cache.mts"))},{namedExports:{readDiscoveryCache:()=>{throw Error('Unexpected cache read');}}});
      mock.module(${JSON.stringify(dependency("./daily-discovery-session.mts"))},{namedExports:{runDiscoverySession:async(observed,root,head)=>{
        assert.equal(observed,state);assert.equal(head,'a'.repeat(40));assert.ok(fetched&&checkedOut);
        for(const name of expected)assert.equal(reads.get(name),2);sessions++;
      }}});
      registerHooks({load(url,context,next){const loaded=next(url,context);if(url!==entry)return loaded;
        let source=String(loaded.source);
        if(variant==='renamed-reordered'){
          const start=source.indexOf('export function fetchDiscoveryMetadata('),end=source.indexOf('async function optional(',start);
          assert.ok(start>=0&&end>start);const declaration=source.slice(start,end);source=source.slice(0,start)+source.slice(end)+'\\n'+declaration;
          source=source.replaceAll('discoveryBootstrapModules','$loadedModules').replaceAll('fetchDiscoveryMetadata','$fetchMetadata');
        }
        if(variant==='bypassed-fetch'){assert.ok(source.includes('fetchDiscoveryMetadata(git);'));source=source.replace('fetchDiscoveryMetadata(git);','');}
        if(variant==='omitted-input'){assert.ok(source.includes('"runtime-values.mts",'));source=source.replace('"runtime-values.mts",','');}
        if(variant==='removed-graph-guard'){assert.ok(source.includes('"--no-write-commit-graph",'));source=source.replace('"--no-write-commit-graph",','');}
        if(variant==='removed-maintenance-guard'){assert.ok(source.includes('"--no-auto-maintenance",'));source=source.replace('"--no-auto-maintenance",','');}
        return {...loaded,source};
      }});
      const {dailyDiscoveryMain}=await import(entry);
      if(variant==='changed-bootstrap'){await assert.rejects(dailyDiscoveryMain(['run','--state-dir',state]),/Loaded bootstrap updated/);assert.equal(sessions,0);}
      else{await dailyDiscoveryMain(['run','--state-dir',state]);assert.equal(sessions,1);}
      console.log('PASS actual discovery startup');
    `;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const driver = path.join(state, "driver.mjs");
    writeFileSync(driver, program);
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", driver], {
      encoding: "utf8",
      env,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    if (
      variant === "bypassed-fetch" ||
      variant === "omitted-input" ||
      variant === "removed-graph-guard" ||
      variant === "removed-maintenance-guard"
    ) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /bounded fetch must precede checkout|AssertionError/u);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PASS actual discovery startup/u);
    }
  }
});
void test("provider quota protects delivery independently of the local request allowance", () => {
  const budget = new DiscoveryBudget("ordinary");
  budget.reserveDelivery(60, 1024);
  budget.observeProvider({ resource: "graphql", remaining: 600, resetAt: "2099-01-01T00:00:00Z" });
  assert.throws(() => budget.admitProvider("graphql", 1), /delivery reserve/);
  assert.equal(budget.remaining().requests, 140);
  budget.delivery = true;
  budget.admitProvider("graphql", 600);
  assert.throws(() => budget.admitProvider("graphql", 601), /quota/);
  assert.throws(() => budget.requireProviderCapacity(60), /core.*unknown/);
  budget.observeProvider({ resource: "core", remaining: 61, resetAt: "2099-01-01T00:00:00Z" });
  budget.requireProviderCapacity(60);
  budget.observeProvider({ resource: "graphql", remaining: 0, resetAt: "2099-01-01T00:00:00Z" });
  assert.throws(() => budget.requireProviderCapacity(1), /2099/);
  budget.observeProvider({ resource: "core", remaining: 0, resetAt: "2100-01-01T00:00:00Z" });
  budget.observeProvider({ resource: "graphql", remaining: 0, resetAt: "2099-01-01T00:00:00Z" });
  budget.retainBackoff("2098-01-01T00:00:00Z");
  assert.equal(budget.usage.backoff_until, "2100-01-01T00:00:00Z");
});
void test("bounded transport charges quota observations and stops before spending delivery headroom", (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(path.join(root, "work"), { recursive: true });
  const state = mkdtempSync(path.join(root, "work/discovery-quota-fixture-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const worker = path.join(state, "worker.mjs");
  writeFileSync(
    worker,
    `for await (const _ of process.stdin) {}\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ requests: 1, bytes: 2, status: 200, headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "600", "x-ratelimit-reset": "4070908800" }, text: "{}" })}));`,
  );
  const budget = new DiscoveryBudget("ordinary");
  const transport = createDiscoveryTransport(budget, "fixture-token", worker);
  transport.request("POST", "https://api.github.com/graphql", "{}");
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.bytes, 2);
  assert.equal(budget.usage.provider_quotas?.graphql?.remaining, 600);
  budget.reserveDelivery(60, 1024);
  assert.throws(
    () => transport.request("POST", "https://api.github.com/graphql", "{}"),
    /delivery reserve/,
  );
  assert.equal(budget.usage.requests, 1);
});
void test("successful comment identity survives later readback denial and deletion without reposting", () => {
  const candidate: DiscoveryMutation = { status: "reviewed" };
  let posts = 0;
  let durable: DiscoveryMutation = { ...candidate };
  const persist = () => {
    durable = { ...candidate };
  };
  const response = discoveryPost(
    candidate,
    () => {
      posts++;
      return { id: 123 };
    },
    persist,
  );
  recordDiscoveryComment(candidate, response.id, persist);
  assert.throws(() => {
    throw new GitHubApiError("http_error", "readback denied", { status: 403 });
  }, /readback denied/);
  assert.equal(durable.status, "created");
  assert.equal(durable.created_comment, 123);
  assert.throws(() => assertDiscoveryCommentMayPost(durable), /without reposting/);
  assert.equal(posts, 1);
  const rejected: DiscoveryMutation = { status: "reviewed" };
  assert.throws(
    () =>
      discoveryPost(
        rejected,
        () => {
          throw new GitHubApiError("http_error", "POST denied", { status: 403 });
        },
        () => {},
      ),
    /POST denied/,
  );
  assert.equal(rejected.status, "reviewed");
  const unknown: DiscoveryMutation = { status: "reviewed" };
  assert.throws(
    () =>
      discoveryPost(
        unknown,
        () => {
          throw new Error("connection lost");
        },
        () => {},
      ),
    /connection lost/,
  );
  assert.equal(unknown.status, "create-attempted");
  assert.throws(() => assertDiscoveryCommentMayPost(unknown), /without reposting/);
  const created: DiscoveryMutation = { status: "reviewed" };
  assert.throws(
    () =>
      discoveryPost(
        created,
        () => {
          created.created_issue = 42;
          created.status = "created";
          throw new GitHubApiError("http_error", "Project denied", { status: 403 });
        },
        () => {},
      ),
    /Project denied/,
  );
  assert.equal(created.status, "created");
  assert.equal(created.created_issue, 42);
});
void test("doctor rejection rules and order match the independently reviewed pre-change source oracle", () => {
  // Retained source oracle: bb8203480d95671feec0f866bfc5f87353a8a667,
  // original file SHA256 b111e77b459682965cdf8fcc1f646aa3b71faf414aebda11fdc2c03208ebb246;
  // reviewed rule slice SHA2567900795d2bccebf5a731f877e43f0827968a1f0ac7fab4da345cfa6ed511c967.
  // Expected rejection outcomes below are independent of candidate source bytes.
  const program = String.raw`
    import assert from 'node:assert/strict';import {mock} from 'node:test';
    import * as processes from 'node:child_process';
    const forbidden=()=>{throw Error('External effects are forbidden in the doctor contract');};
    process.kill=forbidden;globalThis.fetch=forbidden;
    mock.module('node:child_process',{namedExports:Object.fromEntries(Object.entries(processes)
      .filter(([name])=>name!=='default').map(([name,value])=>[name,typeof value==='function'?forbidden:value]))});
    const readinessUrl=${JSON.stringify(new URL("./roadmap-readiness.mts", import.meta.url).href)};
    const qualificationUrl=${JSON.stringify(new URL("./roadmap-qualification.mts", import.meta.url).href)};
    const actualReadiness=await import(readinessUrl),actualQualification=await import(qualificationUrl);
    const catalog={ports:[]},items=[],risk={ack:'owned'},now='2026-10-28T00:00:00Z';
    let all=false,repositoryIssues,stageCalls=0,readinessCalls=0,coverageCalls=0,lastReadiness;
    const warnings=['independent warning'],diagnostics=[{scope:'owned'}];
    const row=name=>({url:'https://example.invalid/issues/'+name,title:name});
    const readiness=()=>({migrationConflicts:all?[row('migration')]:[],unassignedRequired:all?[row('required')]:[],
      statusConflicts:all?[row('status')]:[],relevantUnclassified:all?[row('unclassified')]:[],
      safetyConflicts:all?[row('safety')]:[],dependencyConflicts:all?[{item:row('dependent'),dependency:row('blocking')}]:[],
      missingProjectDependencies:all?[{item:row('missing'),dependency:row('outside')}]:[],
      truncatedDependencies:all?[row('truncated')]:[],cycles:all?[[11,12,11]]:[]});
    mock.module(readinessUrl,{namedExports:{...actualReadiness,analyzeReleaseReadiness:(observed,release,options)=>{
      assert.equal(observed,items);assert.equal(release,'v1');assert.equal(options.risk706Approval,risk);assert.equal(options.now,now);
      readinessCalls++;return lastReadiness=readiness();
    }}});
    mock.module(qualificationUrl,{namedExports:{...actualQualification,
      validatePortStageSemantics:(observed,issues)=>{assert.equal(observed,catalog);assert.equal(issues,items);stageCalls++;return {errors:all?['stage guard']:[],warnings,diagnostics};},
      validatePortIssueCoverage:(observed,issues,repository,inventory)=>{
        assert.equal(observed,catalog);assert.equal(issues,items);assert.equal(repository,'owner/repo');assert.equal(inventory,repositoryIssues);
        coverageCalls++;return all?['catalog coverage']:[];
      },
    }});
    const {evaluateRoadmapDoctor,uxAuditOriginIds}=await import(${JSON.stringify(new URL("./roadmap.mts", import.meta.url).href)});
    const canonical={number:36,url:'https://example.invalid/issues/36',
      body:'<!-- portcove-ux-audit-origins: '+uxAuditOriginIds.join(' ')+' --> PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04'};
    const expected=[
      'https://example.invalid/issues/migration retains an unmigrated active target',
      'https://example.invalid/issues/required is Required without a target',
      'https://example.invalid/issues/status has inconsistent repository/Project status',
      'catalog coverage','stage guard',
      'Superseded wording audit is referenced as current authority: https://example.invalid/issues/37',
      'Supported-source plan origin must have exactly one canonical issue owner; found 2',
      'v1 work is unclassified: https://example.invalid/issues/unclassified',
      'v1 safety work is not Required: https://example.invalid/issues/safety',
      'https://example.invalid/issues/dependent has a conflicting blocking dependency https://example.invalid/issues/blocking',
      'https://example.invalid/issues/missing has a blocking dependency outside the Project: https://example.invalid/issues/outside',
      'https://example.invalid/issues/truncated has more than 10 blocking dependencies; readiness query is incomplete',
      'blocking dependency cycle: #11 -> #12 -> #11',
    ];
    for(const selected of [[],['drift'],['all'],['all','drift']]){
      all=selected.includes('all');const drift=selected.includes('drift')?['configuration drift']:[];
      repositoryIssues=all?[canonical,{number:37,url:'https://example.invalid/issues/37',
        body:'portcove-wording-audit-origins PCV-PLAN-SUPPORTED-SOURCE-PROVENANCE-2026-09-04'}]:[canonical];
      const execute=()=>evaluateRoadmapDoctor({config:{active_release:'v1',repository:'owner/repo'},catalog,items,repositoryIssues,drift,risk706Approval:risk,now});
      const errors=[...drift,...(all?expected:[])];
      if(errors.length)assert.throws(execute,error=>{assert.deepEqual(error.doctorErrors,errors);assert.equal(error.message,'Project drift:\n'+errors.map(value=>'- '+value).join('\n'));return true;});
      else{const result=execute();assert.equal(result.warnings,warnings);assert.equal(result.diagnostics,diagnostics);assert.equal(result.readiness,lastReadiness);}
    }
    assert.equal(stageCalls,4);assert.equal(readinessCalls,4);assert.equal(coverageCalls,4);
  `;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", "--input-type=module", "--eval", program],
    {
      env: environment,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
void test("fixed profiles, weekly rebuild, reservation replacement, deadlines and provider backoff", () => {
  let now = Date.parse("2026-10-17T00:00:00Z");
  const b = new DiscoveryBudget(
    "ordinary",
    () => {},
    () => now,
  );
  assert.equal(selectDiscoveryProfile(undefined, now), "cold");
  const cache = {
    format: 1,
    repository: "owner/repo",
    repository_node_id: "REPO",
    observed_at: new Date(now).toISOString(),
    issues: [],
  };
  assert.equal(
    selectDiscoveryProfile({ ...cache, baseline_completed_at: new Date(now).toISOString() }, now),
    "ordinary",
  );
  assert.equal(
    selectDiscoveryProfile({ ...cache, baseline_completed_at: "2026-10-10T00:00:00Z" }, now),
    "cold",
  );
  b.reserveDelivery(150, 1024);
  b.reserveDelivery(175, 2048);
  assert.equal(b.remaining().requests, 25);
  assert.throws(() => b.admit(26, 1), /budget/);
  assert.throws(() => b.admit(-1, 1), /Invalid/);
  b.usage.backoff_until = new Date(now + 1000).toISOString();
  assert.throws(() => b.admit(1, 1), /backoff/);
  now += 2000;
  b.admit(1, 1);
  b.delivery = true;
  b.admit(200, 20 * 1024 * 1024);
  now += 30 * 60000;
  assert.throws(() => b.admit(0, 0), /budget/);
});
void test("bounded stream stops on response cap, counts redirects, and strips credentials outside GitHub", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({
      url: url instanceof URL ? url.href : typeof url === "string" ? url : url.url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return calls.length === 1
      ? new Response("redirect", {
          status: 302,
          headers: { location: "https://objects.githubusercontent.com/report" },
        })
      : new Response("done");
  };
  const got = await boundedDiscoveryRequest(envelope, fetcher);
  assert.equal(got.requests, 2);
  assert.equal(got.bytes, 12);
  assert.equal(got.text, "done");
  assert.equal(calls[0]?.auth, "Bearer test-secret");
  assert.equal(calls[1]?.auth, null);
  const tooBig = await boundedDiscoveryRequest(
    { ...envelope, cap: 8 },
    async () => new Response("0123456789"),
  );
  assert.match("error" in tooBig ? tooBig.error : "", /cap exhausted/);
  assert.equal(tooBig.bytes, 10);
  assert.equal(tooBig.text, "");
  const noRedirect = await boundedDiscoveryRequest(
    { ...envelope, method: "POST" },
    async () => new Response("", { status: 307, headers: { location: "/other" } }),
  );
  assert.equal(noRedirect.requests, 1);
  assert.match("error" in noRedirect ? noRedirect.error : "", /Mutation redirects/);
  const limit = await boundedDiscoveryRequest(
    { ...envelope, maxRequests: 1 },
    async () => new Response("", { status: 302, headers: { location: "/other" } }),
  );
  assert.equal(limit.requests, 1);
  assert.match("error" in limit ? limit.error : "", /budget exhausted/);
});
void test("timeouts, failed reads and Retry-After retain charged attempts without retries", async () => {
  let calls = 0;
  const failure = await boundedDiscoveryRequest(envelope, async () => {
    calls++;
    throw new Error("offline");
  });
  assert.equal(calls, 1);
  assert.equal(failure.requests, 1);
  assert.match("error" in failure ? failure.error : "", /offline/);
  const backoff = await boundedDiscoveryRequest(
    envelope,
    async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
  );
  assert.ok(Date.parse(backoff.backoff_until ?? "") > Date.now() + 59000);
  const exhausted = await boundedDiscoveryRequest(
    envelope,
    async () =>
      new Response('{"errors":[{"type":"RATE_LIMITED"}]}', {
        status: 200,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4070908800" },
      }),
  );
  assert.equal(exhausted.requests, 1);
  assert.equal(exhausted.backoff_until, "2099-01-01T00:00:00.000Z");
  await assert.rejects(boundedDiscoveryRequest({ ...envelope, timeout: 21000 }), /Invalid bounded/);
});
function zip(text: string, declaredSize?: number) {
  const name = Buffer.from("report.json"),
    raw = Buffer.from(text),
    packed = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(raw), 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(declaredSize ?? raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  const before = Buffer.concat([local, name, packed]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(before.length, 16);
  return Buffer.concat([before, central, name, end]);
}
void test("observer ZIP validates digest, structure, declared expansion and actual inflation cap", () => {
  const bytes = zip('{"ok":true}');
  assert.deepEqual(
    readDiscoveryReport(bytes, `sha256:${createHash("sha256").update(bytes).digest("hex")}`).report,
    { ok: true },
  );
  assert.throws(() => readDiscoveryReport(bytes, "sha256:bad"), /digest mismatch/);
  assert.throws(() => readDiscoveryReport(zip("{}", 3 * 1024 * 1024)), /Invalid/);
  assert.throws(
    () => readDiscoveryReport(zip("x".repeat(2 * 1024 * 1024 + 1), 1)),
    /buffer|length|size|larger/iu,
  );
  assert.throws(
    () => readDiscoveryReport(bytes.subarray(0, bytes.length - 10)),
    /archive|directory/,
  );
});
void test("control input rejects an overlong unterminated message while reading", async () => {
  const input = boundedDiscoveryInput();
  input.resume();
  const error = once(input, "error");
  input.write(Buffer.alloc(128 * 1024, 32));
  input.write(Buffer.alloc(1, 32));
  const failures: unknown[] = await error;
  assert.ok(failures[0] instanceof Error);
  assert.match(failures[0].message, /exceeds cap/);
});

void test("fresh observed capacity admits more than historical request counts without dropping finite resources", () => {
  let now = Date.parse("2026-10-27T00:00:00Z");
  const budget = new DiscoveryBudget(
    "ordinary",
    () => {},
    () => now,
  );
  budget.observeProvider({
    resource: "core",
    remaining: 1000,
    resetAt: new Date(now + 3600000).toISOString(),
  });
  budget.charge("GET", "repos/o/r", 1, 100, "200");
  now += 10;
  for (let i = 1; i < 350; i++) {
    budget.admit(1, 100);
    budget.charge("GET", "repos/o/r", 1, 100, "200");
    now += 10;
  }
  assert.equal(budget.usage.requests, 350);
  budget.reserveDelivery(600, 1024);
  assert.ok(budget.remaining().requests <= 50);
  assert.throws(() => budget.admit(51, 1), /budget/);
  budget.delivery = true;
  assert.throws(() => budget.admit(1, budget.limits.bytes), /budget/);
  budget.observeProvider({
    resource: "core",
    remaining: 0,
    resetAt: new Date(now + 3600000).toISOString(),
  });
  assert.throws(() => budget.admit(1, 1), /backoff/);
  now += 3600001;
  assert.throws(() => budget.admit(1, 1), /budget/);
});

void test("observed response costs and runtime reduce adaptive admission", () => {
  let now = Date.parse("2026-10-27T00:00:00Z");
  const budget = new DiscoveryBudget(
    "ordinary",
    () => {},
    () => now,
  );
  budget.observeProvider({
    resource: "core",
    remaining: 1000,
    resetAt: new Date(now + 3600000).toISOString(),
  });
  budget.charge("GET", "repos/o/r", 1, 9 * 1024 * 1024, "200");
  now += 1;
  assert.equal(
    budget.remaining().requests,
    1,
    "remaining retained bytes admit only one observed-size operation",
  );
  assert.throws(() => budget.admit(2, 1), /budget/);
  now += 29 * 60000;
  assert.equal(budget.remaining().requests, 0, "observed elapsed cost leaves insufficient runtime");
});

void test("quiet rotation resumes past fifty from per-operation durable checkpoints", async (t) => {
  const root = mkdtempSync(
    path.join(await import("node:os").then((m) => m.tmpdir()), "discovery-capacity-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(
    readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  ) as ConstructorParameters<typeof discoverySession.DiscoverySession>[2];
  const calls: number[] = [];
  const allowRecheck = new Set<number>();
  const make = (runId: string) => {
    const run = path.join(root, runId);
    mkdirSync(run);
    const session = new discoverySession.DiscoverySession(
      root,
      run,
      config,
      "fixture-token",
      new Date().toISOString(),
      "fixture-head",
    );
    const budget = new DiscoveryBudget("ordinary");
    const api = new GitHubApiClient((args) => {
      const endpoint = args[2]!;
      const id = Number(endpoint.match(/game-(\d+)$/u)?.[1]);
      assert.ok(id > 0);
      // Every prior successful operation must already be on disk before this read.
      if (calls.length) {
        const durable = JSON.parse(readFileSync(path.join(root, "active-run.json"), "utf8")) as {
          checkpoint: { checked: Record<string, string> };
        };
        assert.ok(durable.checkpoint.checked[calls.at(-1)!]);
      }
      assert.ok(
        !calls.includes(id) || allowRecheck.has(id),
        "completed identities are not read again on resume",
      );
      calls.push(id);
      budget.charge("GET", endpoint, 1, 100, "200");
      return `HTTP/2 200\n\n${JSON.stringify({ id, full_name: `ports/game-${id}`, archived: false })}`;
    });
    Object.assign(session.client, { api });
    Object.assign(session, {
      budget,
      leadWorkComplete: () => true,
      inventory: {
        issues: Array.from({ length: 75 }, (_, index) => ({
          id: `I${index + 1}`,
          number: index + 1,
          title: `[Port] Game ${index + 1}`,
          state: "OPEN",
          updatedAt: "2026-10-26T00:00:00Z",
          body: renderPortIssueBody({
            title: `Game ${index + 1}`,
            upstream: `https://github.com/ports/game-${index + 1}`,
            portKey: `game-${index + 1}`,
          }),
        })),
      },
    });
    return session;
  };
  const first = make("first");
  first.budget.reserveDelivery(145, 1024);
  assert.equal(first.recheck().checked.length, 55);
  assert.equal(calls.length, 55);
  // Construct the real interrupted-session reader, not a hand-copied checkpoint.
  const resumed = make("resumed");
  assert.equal(resumed.recheck().checked.length, 20);
  assert.equal(calls.length, 75);
  assert.equal(resumed.recheck().checked.length, 0);
  const changed = resumed.inventory.issues[0]!;
  allowRecheck.add(1);
  changed.body += "\nChanged source contract";
  // Body hashing catches changes even within the provider timestamp resolution.
  assert.deepEqual(resumed.recheck().checked, [1]);
  delete changed.updatedAt;
  assert.deepEqual(resumed.recheck().checked, [1], "unknown revisions cannot inherit freshness");
  assert.ok(!resumed.checkpoint.checked_revisions?.[1]);
});

void test("thirteen complete investigations retain independently bound evidence within resource admission", async (t) => {
  const root = mkdtempSync(
    path.join(await import("node:os").then((m) => m.tmpdir()), "discovery-research-capacity-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  mkdirSync(run);
  const config = JSON.parse(
    readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  ) as ConstructorParameters<typeof discoverySession.DiscoverySession>[2];
  const session = new discoverySession.DiscoverySession(
    root,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  const api = new GitHubApiClient((args) => {
    const endpoint = args[2]!;
    session.budget.charge("GET", endpoint, 1, 100, "200");
    const repository = endpoint.match(/^repos\/([^/]+\/[^/?]+)/u)![1]!;
    let body: unknown;
    if (endpoint.endsWith("per_page=10")) body = [];
    else if (endpoint.includes("/git/ref/heads/")) body = { object: { sha: "a".repeat(40) } };
    else if (endpoint.includes("/readme?"))
      body = {
        sha: "b".repeat(40),
        content: Buffer.from("Reviewed upstream setup").toString("base64"),
      };
    else if (endpoint.includes("/contents/")) return "HTTP/2 404\n\n{}";
    else
      body = {
        id: Number(repository.split("-").at(-1)),
        full_name: repository,
        default_branch: "main",
        archived: false,
        fork: false,
      };
    return `HTTP/2 200\n\n${JSON.stringify(body)}`;
  });
  Object.assign(session.source, { api });
  for (let id = 1; id <= 13; id++) session.research(`ports/game-${id}`);
  assert.equal(session.deepInvestigations, 13);
  assert.equal(Object.keys(session.journal.evidence).length, 13);
  const resumedRun = path.join(root, "resumed");
  mkdirSync(resumedRun);
  const resumed = new discoverySession.DiscoverySession(
    root,
    resumedRun,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  assert.equal(Object.keys(resumed.journal.evidence).length, 13);
});

void test("a logical journal beyond five candidates resumes verified batches without splitting or repeated writes", async (t) => {
  const root = mkdtempSync(
    path.join(await import("node:os").then((m) => m.tmpdir()), "discovery-intake-capacity-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(
    readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  ) as ConstructorParameters<typeof discoverySession.DiscoverySession>[2];
  const writes = new Set<string>();
  const batches: number[] = [];
  const make = (name: string, interrupt: boolean) => {
    const run = path.join(root, name);
    mkdirSync(run);
    const session = new discoverySession.DiscoverySession(
      root,
      run,
      config,
      "fixture-token",
      new Date().toISOString(),
      "fixture-head",
    );
    Object.assign(session, {
      inventory: { issues: [], items: [], archivedItems: [] },
      budget: new DiscoveryBudget("ordinary"),
    });
    session.checkProviderCapacity = () => {
      for (const resource of ["core", "graphql"])
        session.budget.observeProvider({
          resource,
          remaining: 10000,
          resetAt: new Date(Date.now() + 3600000).toISOString(),
        });
    };
    // Exercise admission, durable candidates, production write journal guards and
    // the real interrupted reader. This fixture does not claim hosted mutation evidence.
    session.applyBatch = async (candidates) => {
      batches.push(candidates.length);
      for (const candidate of candidates) {
        discoveryPost(
          candidate,
          () => {
            assert.ok(!writes.has(candidate.id));
            writes.add(candidate.id);
            return { id: writes.size };
          },
          () => session.persist(),
        );
        candidate.status = "delivered";
        session.budget.charge("POST", "fixture/readback-verified", 10, 100, "200");
        session.persist();
      }
      if (interrupt) throw new Error("fixture interruption after verified batch");
      return {
        delivered: candidates.map((c) => ({ id: c.id, issue: c.issue, readback: c.readback })),
      };
    };
    return session;
  };
  const first = make("first", true);
  const evidenceHash = (await import("./upstream-observer.mts")).observationHash;
  for (let id = 1; id <= 13; id++) {
    const body = `reviewed-${id}`;
    first.journal.candidates[String(id)] = {
      id: String(id),
      kind: "comment",
      title: `Game ${id}`,
      upstream: `https://github.com/ports/game-${id}`,
      portKey: `game-${id}`,
      issue: id,
      body,
      body_sha256: evidenceHash(body),
      evidence_ids: [],
      evidence_sha256: evidenceHash([]),
      status: "reviewed",
      review: {
        verdict: "clear",
        body_sha256: evidenceHash(body),
        evidence_sha256: evidenceHash([]),
      },
    };
  }
  await assert.rejects(first.apply(), /fixture interruption/);
  assert.ok(writes.size > 5 && writes.size < 13);
  const resumed = make("resumed", false);
  const result = await resumed.apply();
  assert.equal(result.pending, 0);
  assert.equal(writes.size, 13);
  assert.ok(batches.length >= 2);
  assert.ok(Object.values(resumed.journal.candidates).every((c) => c.status === "delivered"));
  await resumed.apply();
  assert.equal(writes.size, 13);
});

void test("GraphQL capacity admits a smaller prefix and later reset continues the same logical queue", async () => {
  const session = Object.create(
    discoverySession.DiscoverySession.prototype,
  ) as discoverySession.DiscoverySession;
  const budget = new DiscoveryBudget("ordinary");
  let graphql = 500;
  const writes: string[] = [];
  const batches: number[] = [];
  Object.assign(session, {
    budget,
    inventory: { issues: [], items: [], archivedItems: [] },
    journal: {
      candidates: Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [
          String(i),
          {
            id: String(i),
            status: "reviewed",
            body: "reviewed",
            evidence_ids: [],
          },
        ]),
      ),
      evidence: {},
      notes: [],
    },
    persist: () => {},
    checkProviderCapacity: () => {
      budget.observeProvider({
        resource: "core",
        remaining: 10000,
        resetAt: "2099-01-01T00:00:00Z",
      });
      budget.observeProvider({
        resource: "graphql",
        remaining: graphql,
        resetAt: "2099-01-01T00:00:00Z",
      });
    },
  });
  session.applyBatch = async (candidates) => {
    batches.push(candidates.length);
    for (const candidate of candidates) {
      assert.ok(!writes.includes(candidate.id));
      writes.push(candidate.id);
      candidate.status = "delivered";
    }
    graphql = 100;
    return {
      delivered: candidates.map((c) => ({ id: c.id, issue: c.issue, readback: c.readback })),
    };
  };
  const partial = await session.apply();
  assert.deepEqual(batches, [1]);
  assert.equal(partial.pending, 2);
  assert.equal(session.journal.delivery, "pending");
  graphql = 1000;
  const completed = await session.apply();
  assert.equal(completed.pending, 0);
  assert.deepEqual(batches, [1, 2]);
  assert.deepEqual(writes, ["0", "1", "2"]);
});

void test("automatic delivery batches retain separate doctor evidence files and journal receipts", async (t) => {
  const root = mkdtempSync(
    path.join(await import("node:os").then((m) => m.tmpdir()), "discovery-doctors-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  mkdirSync(run);
  const config = JSON.parse(
    readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  ) as ConstructorParameters<typeof discoverySession.DiscoverySession>[2];
  const session = new discoverySession.DiscoverySession(
    root,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  Object.assign(session, {
    inventory: { issues: [], items: [], archivedItems: [] },
    checkProviderCapacity: () => {},
    refresh: () => session.inventory,
  });
  await session.applyBatch([]);
  await session.applyBatch([]);
  const receipts = session.journal.doctors as { evidence: string; scope: string }[];
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0]!.evidence, receipts[1]!.evidence);
  for (const receipt of receipts) {
    assert.equal(receipt.scope, "none");
    assert.deepEqual(JSON.parse(readFileSync(receipt.evidence, "utf8")), {
      scope: "none",
      global_health: "not_evaluated",
      reason: "no roadmap changes",
    });
  }
  const nextRun = path.join(root, "next");
  mkdirSync(nextRun);
  const resumed = new discoverySession.DiscoverySession(
    root,
    nextRun,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  assert.deepEqual(resumed.journal.doctors, receipts);
});

void test("holding the final candidate cannot bypass a resumed substantial change's global check", async (t) => {
  const work = fileURLToPath(new URL("../work/", import.meta.url));
  mkdirSync(work, { recursive: true });
  const root = mkdtempSync(path.join(work, "discovery-global-finalization-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(
    readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8"),
  ) as ConstructorParameters<typeof discoverySession.DiscoverySession>[2];
  const make = (name: string) => {
    const run = path.join(root, name);
    mkdirSync(run);
    return new discoverySession.DiscoverySession(
      root,
      run,
      config,
      "fixture-token",
      new Date().toISOString(),
      "fixture-head",
    );
  };
  const first = make("first");
  const hash = (await import("./upstream-observer.mts")).observationHash;
  first.journal.candidates.held = {
    id: "held",
    kind: "comment",
    title: "Held final candidate",
    upstream: "https://github.com/ports/held",
    portKey: "held",
    body: "held",
    body_sha256: hash("held"),
    evidence_ids: [],
    evidence_sha256: hash([]),
    status: "held",
  };
  first.journal.global_doctor_pending = true;
  first.journal.doctor = { status: "passed", scope: "issues", evidence: "earlier-scoped-batch" };
  first.persist();
  const resumed = make("resumed");
  assert.equal(resumed.journal.global_doctor_pending, true);
  resumed.journal.collection_done = true;
  Object.assign(resumed, { leadWorkComplete: () => true });
  let checks = 0;
  resumed.applyBatch = async (candidates) => {
    assert.equal(candidates.length, 0, "finalization must perform no candidate mutations");
    checks++;
    throw new Error("global validation unavailable");
  };
  const receipt = await resumed.finish();
  assert.equal(checks, 1);
  assert.equal(receipt.status, "failed");
  assert.equal(resumed.journal.global_doctor_pending, true);
  const next = make("next");
  assert.equal(next.journal.global_doctor_pending, true);
  next.applyBatch = resumed.applyBatch;
  await assert.rejects(next.apply(), /global validation unavailable/);
  assert.equal(checks, 2);
});
