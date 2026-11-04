import { replacePreparedFile } from "./prepared-file-replacement.mts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { once } from "node:events";
import { isBuiltin } from "node:module";
import { DiscoveryBudget, selectDiscoveryProfile } from "./discovery-budget.mts";
import { boundedDiscoveryRequest } from "./discovery-http.mts";
import { boundedDiscoveryInput } from "./daily-discovery-session.mts";
import { readDiscoveryReport } from "./discovery-artifact.mts";
import { deflateRawSync, crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
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
import { GitHubApiError } from "./github-operation.mts";
import { createGitHubClient } from "./github-client.mts";
import { discoveryGitHubScope } from "./discovery-github.mts";
import { fixtureGitHub } from "./fixtures/github-sdk-fixtures.mts";
import { renderPortIssueBody } from "./roadmap-issue.mts";
import { renameSync, readdirSync } from "node:fs";
import * as discoverySession from "./daily-discovery-session.mts";
import {
  discoveryBootstrapModules,
  discoveryDependencyInputs,
  fetchDiscoveryMetadata,
} from "./daily-discovery.mts";
const envelope = {
  url: "https://api.github.com/repos/o/r/actions/artifacts/1/zip",
  binary: true,
  method: "GET",
  cap: 1024,
  timeout: 1000,
  maxRequests: 5,
  token: "test-secret",
};
void test(
  "Windows reader sharing permits bounded atomic state replacement and preserves persistent failure",
  { skip: process.platform !== "win32", timeout: 20000 },
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
    for (const asynchronous of [false, true]) {
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
            if (asynchronous) {
              writeFileSync(probe, JSON.stringify({ requests: 134 }));
              await replacePreparedFile(probe, target);
            } else discoverySession.atomic(target, { requests: 134 });
            assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { requests: 134 });
          } else {
            if (asynchronous) {
              writeFileSync(probe, JSON.stringify({ requests: 135 }));
              await assert.rejects(replacePreparedFile(probe, target), { code: "EPERM" });
              assert.deepEqual(JSON.parse(readFileSync(probe, "utf8")), { requests: 135 });
            } else
              assert.throws(() => discoverySession.atomic(target, { requests: 135 }), {
                code: "EPERM",
              });
            assert.equal(readFileSync(target, "utf8"), "old");
            const pending = asynchronous
              ? "probe.next"
              : readdirSync(state).find(
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
    }
  },
);
void test("bootstrap identity covers the complete statically loaded module closure", async () => {
  // The filtered Windows reader-sharing route runs before package installation.
  const { readFixtureModuleClosure } = await import("./fixtures/module-closure.mts");
  const entry = new URL("./daily-discovery.mts", import.meta.url);
  // The maintained production bootstrap list remains the independent expectation.
  // Later imports belong to the separately captured runner/execution inputs.
  const closure = readFixtureModuleClosure(
    path.dirname(fileURLToPath(entry)),
    ["daily-discovery.mts"],
    {
      includeDynamicImports: false,
    },
  );
  assert.deepEqual(
    closure.external.filter((name) => !isBuiltin(name)),
    [],
    "Bootstrap must import before its frozen package installation",
  );
  const loaded = closure.modules.map((module) => module.path);
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
    "changed-dependency",
    "failed-install",
    "changed-during-install",
    "bypassed-fetch",
    "omitted-input",
    "removed-graph-guard",
    "removed-maintenance-guard",
  ]) {
    const program = `
      import assert from 'node:assert/strict';import {mock} from 'node:test';
      import {registerHooks} from 'node:module';import path from 'node:path';
      const entry=${JSON.stringify(entry)},state=${JSON.stringify(state)},variant=${JSON.stringify(variant)};
      const expected=${JSON.stringify([...discoveryBootstrapModules.map((name) => `scripts/${name}`), ...discoveryDependencyInputs])};
      const root=path.dirname(path.dirname(new URL(entry).pathname));
      let fetched=false,checkedOut=false,installed=false,sessions=0;const reads=new Map();
      process.env.GH_TOKEN="synthetic-install-secret";process.env.GITHUB_TOKEN="synthetic-other-secret";
      const clean=environment=>{assert.equal(environment.GH_TOKEN,undefined);assert.equal(environment.GITHUB_TOKEN,undefined);assert.equal(environment.NODE_OPTIONS,undefined);};
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
      mock.module('node:fs/promises',{namedExports:{mkdir:async()=>{},writeFile:async(file)=>{assert.ok(file.startsWith(state+path.sep));},readFile:async(file,encoding)=>{
        const name=path.relative(root,file).split(path.sep).join('/');assert.ok(expected.includes(name),'Unexpected bootstrap read: '+name);
        const count=(reads.get(name)||0)+1;reads.set(name,count);
        const changed=(variant==='changed-bootstrap'&&checkedOut&&name==='scripts/runtime-values.mts')||((variant==='changed-dependency'&&checkedOut||variant==='changed-during-install'&&installed)&&name==='pnpm-lock.yaml');
        const value=name==='package.json'?JSON.stringify({packageManager:'pnpm@99.0.0'}):name==='.node-version'?process.version.slice(1):name+(changed?'changed':'');
        return encoding==='utf8'?value:Buffer.from(value);
      }}});
      mock.module(${JSON.stringify(dependency("./observer-checkpoint-storage.mts"))},{namedExports:{withCheckpointLock:async(file,body)=>{assert.equal(file,path.join(state,'investigation'));await body();}}});
      mock.module(${JSON.stringify(dependency("./release-path-safety.mts"))},{namedExports:{assertOwnedUnlinkedPath:async(parent,value)=>{assert.equal(value,state);return state;}}});
      mock.module(${JSON.stringify(dependency("./discovery-budget.mts"))},{namedExports:{selectDiscoveryProfile:()=>{throw Error('Unexpected profile selection');},discoveryProfiles:{}}});
      mock.module(${JSON.stringify(dependency("./discovery-cache.mts"))},{namedExports:{readDiscoveryCache:()=>{throw Error('Unexpected cache read');}}});
      mock.module(${JSON.stringify(dependency("./dev-storage.mts"))},{namedExports:{spawnCommand:(command,args,options)=>{
        assert.ok(checkedOut);assert.equal(command,'pnpm');assert.deepEqual(args,['--version']);clean(options.env);
        return {status:0,stdout:'99.0.0\\n'};
      }}});
      mock.module(${JSON.stringify(dependency("./resource-command.mts"))},{namedExports:{bootstrapOutputResources:environment=>{clean(environment);return ['fixture-output'];},runResourceCommand:async(profile,executable,args,options)=>{
        assert.ok(checkedOut);assert.equal(profile,'analysis');assert.equal(executable,process.execPath);
        assert.deepEqual(args,[path.join(root,'scripts/dev-storage.mts'),'run','--scope','tooling','--','pnpm','install','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile']);
        clean(options.environment);assert.deepEqual(options.exclusive,['fixture-output']);assert.equal(options.executionTimeoutMilliseconds,600000);
        installed=true;return variant==='failed-install'?1:0;
      }}});
      mock.module(${JSON.stringify(dependency("./daily-discovery-session.mts"))},{namedExports:{runDiscoverySession:async(observed,root,head)=>{
        assert.equal(observed,state);assert.equal(head,'a'.repeat(40));assert.ok(fetched&&checkedOut&&installed);
        for(const name of expected)assert.equal(reads.get(name),name==='package.json'||name==='.node-version'?4:3);sessions++;
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
      if(['changed-bootstrap','changed-dependency','changed-during-install','failed-install'].includes(variant)){await assert.rejects(dailyDiscoveryMain(['run','--state-dir',state]),variant==='changed-bootstrap'?/Loaded bootstrap updated/:variant==='failed-install'?/installation failed/:/Loaded dependency inputs updated/);assert.equal(sessions,0);assert.equal(installed,['changed-during-install','failed-install'].includes(variant));}
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
void test("provider quota protects delivery independently of the local request allowance", async () => {
  const budget = new DiscoveryBudget("ordinary");
  await budget.reserveDelivery(60, 1024);
  budget.observeProvider({ resource: "graphql", remaining: 600, resetAt: "2099-01-01T00:00:00Z" });
  await assert.rejects(async () => await budget.admitProvider("graphql", 1), /delivery reserve/);
  assert.equal(budget.remaining().requests, 140);
  budget.delivery = true;
  await budget.admitProvider("graphql", 600);
  await assert.rejects(async () => await budget.admitProvider("graphql", 601), /quota/);
  await assert.rejects(async () => await budget.requireProviderCapacity(60), /core.*unknown/);
  budget.observeProvider({ resource: "core", remaining: 61, resetAt: "2099-01-01T00:00:00Z" });
  await budget.requireProviderCapacity(60);
  budget.observeProvider({ resource: "graphql", remaining: 0, resetAt: "2099-01-01T00:00:00Z" });
  await assert.rejects(async () => await budget.requireProviderCapacity(1), /2099/);
  budget.observeProvider({ resource: "core", remaining: 0, resetAt: "2100-01-01T00:00:00Z" });
  budget.observeProvider({ resource: "graphql", remaining: 0, resetAt: "2099-01-01T00:00:00Z" });
  budget.retainBackoff("2098-01-01T00:00:00Z");
  assert.equal(budget.usage.backoff_until, "2100-01-01T00:00:00Z");
});
void test("SDK transport charges quota observations and stops before spending delivery headroom", async () => {
  const budget = new DiscoveryBudget("ordinary");
  const sdk = await createGitHubClient(
    discoveryGitHubScope(budget, "fixture-token", {
      fetch: async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "600",
            "x-ratelimit-reset": "4070908800",
          },
        }),
    }),
  );
  await sdk.request("POST /graphql", { query: "query { value }" });
  assert.equal(budget.usage.requests, 1);
  assert.equal(budget.usage.bytes, 2);
  assert.equal(budget.usage.provider_quotas?.graphql?.remaining, 600);
  await budget.reserveDelivery(60, 1024);
  await assert.rejects(
    sdk.request("POST /graphql", { query: "query { value }" }),
    /delivery reserve/u,
  );
  assert.equal(budget.usage.requests, 1);
});
void test("successful comment identity survives later readback denial and deletion without reposting", async () => {
  const candidate: DiscoveryMutation = { status: "prepared" };
  let posts = 0;
  let durable: DiscoveryMutation = { ...candidate };
  const persist = () => {
    durable = { ...candidate };
  };
  const response = await discoveryPost(
    candidate,
    () => {
      posts++;
      return { id: 123 };
    },
    persist,
  );
  await recordDiscoveryComment(candidate, response.id, persist);
  assert.throws(() => {
    throw new GitHubApiError("http_error", "readback denied", { status: 403 });
  }, /readback denied/);
  assert.equal(durable.status, "created");
  assert.equal(durable.created_comment, 123);
  assert.throws(() => assertDiscoveryCommentMayPost(durable), /without reposting/);
  assert.equal(posts, 1);
  const rejected: DiscoveryMutation = { status: "prepared" };
  await assert.rejects(
    async () =>
      await discoveryPost(
        rejected,
        () => {
          throw new GitHubApiError("http_error", "POST denied", { status: 403 });
        },
        () => {},
      ),
    /POST denied/,
  );
  assert.equal(rejected.status, "prepared");
  assertDiscoveryCommentMayPost(rejected);
  const unknown: DiscoveryMutation = { status: "prepared" };
  await assert.rejects(
    async () =>
      await discoveryPost(
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
  const created: DiscoveryMutation = { status: "prepared" };
  await assert.rejects(
    async () =>
      await discoveryPost(
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
void test("fixed profiles, weekly rebuild, reservation replacement, deadlines and provider backoff", async () => {
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
  await b.reserveDelivery(150, 1024);
  await b.reserveDelivery(175, 2048);
  assert.equal(b.remaining().requests, 25);
  await assert.rejects(async () => await b.admit(26, 1), /budget/);
  await assert.rejects(async () => await b.admit(-1, 1), /Invalid/);
  b.usage.backoff_until = new Date(now + 1000).toISOString();
  await assert.rejects(async () => await b.admit(1, 1), /backoff/);
  now += 2000;
  await b.admit(1, 1);
  b.delivery = true;
  await b.admit(200, 20 * 1024 * 1024);
  now += 30 * 60000;
  await assert.rejects(async () => await b.admit(0, 0), /budget/);
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
  assert.equal(got.text, Buffer.from("done").toString("base64"));
  assert.equal(calls[0]?.auth, "Bearer test-secret");
  assert.equal(calls[1]?.auth, null);
  const tooBig = await boundedDiscoveryRequest(
    { ...envelope, cap: 8 },
    async () => new Response("0123456789"),
  );
  assert.match("error" in tooBig ? tooBig.error : "", /cap exhausted/);
  assert.equal(tooBig.bytes, 10);
  assert.equal(tooBig.text, "");
  await assert.rejects(
    boundedDiscoveryRequest({ ...envelope, method: "POST" }),
    /Invalid bounded/u,
  );
  const metadata = await boundedDiscoveryRequest(
    { ...envelope, url: "https://api.github.com/repos/o/r" },
    async () => {
      assert.fail("Metadata bypass must not dispatch");
    },
  );
  assert.match("error" in metadata ? metadata.error : "", /metadata must use the configured SDK/u);
  const limit = await boundedDiscoveryRequest(
    { ...envelope, maxRequests: 1 },
    async () => new Response("", { status: 302, headers: { location: "/other" } }),
  );
  assert.equal(limit.requests, 1);
  assert.match(
    "error" in limit ? limit.error : "",
    /metadata must use the configured SDK|budget exhausted/,
  );
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

void test("fresh observed capacity admits more than historical request counts without dropping finite resources", async () => {
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
    await budget.admit(1, 100);
    budget.charge("GET", "repos/o/r", 1, 100, "200");
    now += 10;
  }
  assert.equal(budget.usage.requests, 350);
  await budget.reserveDelivery(600, 1024);
  assert.ok(budget.remaining().requests <= 50);
  await assert.rejects(async () => await budget.admit(51, 1), /budget/);
  budget.delivery = true;
  await assert.rejects(async () => await budget.admit(1, budget.limits.bytes), /budget/);
  budget.observeProvider({
    resource: "core",
    remaining: 0,
    resetAt: new Date(now + 3600000).toISOString(),
  });
  await assert.rejects(async () => await budget.admit(1, 1), /backoff/);
  now += 3600001;
  await assert.rejects(async () => await budget.admit(1, 1), /budget/);
});

void test("observed response costs and runtime reduce adaptive admission", async () => {
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
  await assert.rejects(async () => await budget.admit(2, 1), /budget/);
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
  ) as Parameters<typeof discoverySession.DiscoverySession.open>[2];
  const calls: number[] = [];
  const allowRecheck = new Set<number>();
  const make = async (runId: string) => {
    const run = path.join(root, runId);
    mkdirSync(run);
    const session = await discoverySession.DiscoverySession.open(
      root,
      run,
      config,
      "fixture-token",
      new Date().toISOString(),
      "fixture-head",
    );
    const budget = new DiscoveryBudget("ordinary");
    const sdk = await fixtureGitHub(({ method, endpoint }) => {
      assert.equal(method, "GET");
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
      return { id, full_name: `ports/game-${id}`, archived: false };
    });
    session.sdk.request = sdk.request;
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
  const first = await make("first");
  await first.budget.reserveDelivery(145, 1024);
  assert.equal((await first.recheck()).checked.length, 55);
  assert.equal(calls.length, 55);
  // Construct the real interrupted-session reader, not a hand-copied checkpoint.
  const resumed = await make("resumed");
  assert.equal((await resumed.recheck()).checked.length, 20);
  assert.equal(calls.length, 75);
  assert.equal((await resumed.recheck()).checked.length, 0);
  const changed = resumed.inventory.issues[0]!;
  allowRecheck.add(1);
  changed.body += "\nChanged source contract";
  // Body hashing catches changes even within the provider timestamp resolution.
  assert.deepEqual((await resumed.recheck()).checked, [1]);
  delete changed.updatedAt;
  assert.deepEqual(
    (await resumed.recheck()).checked,
    [1],
    "unknown revisions cannot inherit freshness",
  );
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
  ) as Parameters<typeof discoverySession.DiscoverySession.open>[2];
  const session = await discoverySession.DiscoverySession.open(
    root,
    run,
    config,
    "fixture-token",
    new Date().toISOString(),
    "fixture-head",
  );
  const sdk = await fixtureGitHub(({ endpoint }) => {
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
    else if (endpoint.includes("/contents/")) return Response.json({}, { status: 404 });
    else
      body = {
        id: Number(repository.split("-").at(-1)),
        full_name: repository,
        default_branch: "main",
        archived: false,
        fork: false,
      };
    return body;
  });
  Object.assign(session.source, { sdk });
  for (let id = 1; id <= 13; id++) await session.research(`ports/game-${id}`);
  assert.equal(session.deepInvestigations, 13);
  assert.equal(Object.keys(session.journal.evidence).length, 13);
  const resumedRun = path.join(root, "resumed");
  mkdirSync(resumedRun);
  const resumed = await discoverySession.DiscoverySession.open(
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
  ) as Parameters<typeof discoverySession.DiscoverySession.open>[2];
  const writes = new Set<string>();
  const batches: number[] = [];
  const make = async (name: string, interrupt: boolean) => {
    const run = path.join(root, name);
    mkdirSync(run);
    const session = await discoverySession.DiscoverySession.open(
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
    session.checkProviderCapacity = async () => {
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
        await discoveryPost(
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
  const first = await make("first", true);
  const evidenceHash = (await import("./upstream-observer.mts")).observationHash;
  for (let id = 1; id <= 13; id++) {
    const body = `prepared-${id}`;
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
      status: "prepared",
    };
  }
  await assert.rejects(first.apply(), /fixture interruption/);
  assert.ok(writes.size > 5 && writes.size < 13);
  const resumed = await make("resumed", false);
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
  ) as Parameters<typeof discoverySession.DiscoverySession.open>[2];
  const session = await discoverySession.DiscoverySession.open(
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
  const resumed = await discoverySession.DiscoverySession.open(
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
  ) as Parameters<typeof discoverySession.DiscoverySession.open>[2];
  const make = async (name: string) => {
    const run = path.join(root, name);
    mkdirSync(run);
    return await discoverySession.DiscoverySession.open(
      root,
      run,
      config,
      "fixture-token",
      new Date().toISOString(),
      "fixture-head",
    );
  };
  const first = await make("first");
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
  const resumed = await make("resumed");
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
  const next = await make("next");
  assert.equal(next.journal.global_doctor_pending, true);
  next.applyBatch = resumed.applyBatch;
  await assert.rejects(next.apply(), /global validation unavailable/);
  assert.equal(checks, 2);
});

async function quotaRefreshFixture(_t: TestContext, mode = "valid") {
  const now = Date.parse("2026-10-30T13:40:00Z");
  let clock = now;
  const calls: { method: string; url: string; token: string }[] = [];
  const budget = new DiscoveryBudget(
    "cold",
    () => {},
    () => clock,
  );
  budget.usage.requests = 339;
  budget.usage.bytes = 18743487;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input).href,
      method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("authorization")?.replace(/^token /u, "") ?? "";
    calls.push({ method, url, token });
    let reset = Math.floor((clock + 3600000) / 1000),
      status = 200;
    const resource = url.endsWith("/graphql") ? "graphql" : "core",
      remaining = token === "repo-token" ? 7 : 4700;
    let body: unknown;
    if (url.endsWith("/rate_limit")) {
      const boundary =
        mode === "boundary" &&
        calls.filter((call) => call.url.endsWith("/rate_limit")).length === 1;
      const row = (count: number) => ({
        limit: 5000,
        remaining: count,
        reset: mode === "stale" || boundary ? Math.floor(clock / 1000) : reset,
      });
      body = {
        resources: {
          core: row(mode === "zero" && token === "repo-token" ? 0 : remaining),
          graphql: row(token === "repo-token" ? 0 : 4700),
          search: row(30),
        },
      };
      if (mode === "missing") body = { resources: {} };
      if (mode === "denied") status = 403;
      if (mode === "broken")
        return new Response("not-json", { headers: { "content-type": "application/json" } });
    } else {
      body = { number: 700 };
      if (mode === "cross" && clock === now) {
        clock = now + 2000;
        reset = Math.floor((now + 1000) / 1000);
      }
    }
    return Response.json(body, {
      status,
      headers: {
        "x-ratelimit-resource": resource,
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(reset),
      },
    });
  };
  const connect = async (token: string) =>
    await createGitHubClient(discoveryGitHubScope(budget, token, { fetch }));
  const project = await connect("project-token");
  budget.observeProvider({
    resource: "core",
    remaining: 4108,
    resetAt: new Date(now + 1000).toISOString(),
  });
  return {
    budget,
    project,
    connect,
    now,
    clock: (value: number) => {
      clock = value;
    },
    calls: () => calls,
  };
}
void test("expired quota refresh preserves one budget and precedes a normal POST", async (t) => {
  const f = await quotaRefreshFixture(t);
  f.clock(f.now + 2000);
  const started = f.budget.usage.started_at,
    bytes = f.budget.usage.bytes;
  await f.project.request("POST /repos/o/r/issues", {});
  assert.deepEqual(
    f.calls().map((c) => [c.method, c.url]),
    [
      ["GET", "https://api.github.com/rate_limit"],
      ["POST", "https://api.github.com/repos/o/r/issues"],
    ],
  );
  assert.equal(f.budget.usage.requests, 341);
  assert(f.budget.usage.bytes > bytes);
  assert.equal(f.budget.usage.started_at, started);
  assert.equal(f.budget.limits.bytes, 64 * 1024 * 1024);
  assert.equal(f.budget.limits.milliseconds, 30 * 60000);
});
void test("a successful quota observation crossing the reset boundary is refreshed before any POST", async (t) => {
  const f = await quotaRefreshFixture(t, "boundary");
  f.clock(f.now + 2000);
  await f.project.request("POST /repos/o/r/issues", {});
  assert.deepEqual(
    f.calls().map((c) => [c.method, new URL(c.url).pathname]),
    [
      ["GET", "/rate_limit"],
      ["GET", "/rate_limit"],
      ["POST", "/repos/o/r/issues"],
    ],
  );
  assert.equal(f.budget.usage.requests, 342);
});
void test("successful admitted POST survives a quota reset during its response", async (t) => {
  const f = await quotaRefreshFixture(t, "cross");
  const first = await f.project.request("POST /repos/o/r/issues", {});
  const data: unknown = first.data;
  assert.ok(isRecord(data));
  assert.equal(data.number, 700);
  assert.equal(f.budget.usage.requests, 340);
  await f.project.request("GET /repos/o/r/issues/700");
  assert.deepEqual(
    f.calls().map((c) => c.method),
    ["POST", "GET", "GET"],
  );
  assert.equal(f.calls()[1]!.url, "https://api.github.com/rate_limit");
});
void test("separate credentials retain conservative quota and unused GraphQL zero does not certify or block another token", async (t) => {
  const f = await quotaRefreshFixture(t);
  const repo = await f.connect("repo-token");
  f.clock(f.now + 2000);
  await repo.request("POST /repos/o/r/issues", {});
  assert.deepEqual(
    f.calls().map((c) => [c.method, c.token]),
    [
      ["GET", "project-token"],
      ["GET", "repo-token"],
      ["POST", "repo-token"],
    ],
  );
  assert(f.budget.usage.provider_quotas!.core!.remaining <= 7);
  assert.equal(f.budget.usage.backoff_until, undefined);
  await f.project.request("POST /graphql", { query: "query { value }" });
  assert.equal(f.calls().length, 4);
  const g = await quotaRefreshFixture(t, "zero");
  const blocked = await g.connect("repo-token");
  g.clock(g.now + 2000);
  await assert.rejects(() => blocked.request("POST /repos/o/r/issues", {}), /backoff|quota/u);
  assert(g.calls().every((c) => c.method === "GET"));
});
void test("denied malformed stale or unknown quota refresh cannot retry or authorize a POST", async (t) => {
  for (const mode of ["denied", "missing", "stale", "broken"])
    await t.test(mode, async (t) => {
      const f = await quotaRefreshFixture(t, mode);
      f.clock(f.now + 2000);
      await assert.rejects(() => f.project.request("POST /repos/o/r/issues", {}));
      await assert.rejects(
        () => f.project.request("POST /repos/o/r/issues", {}),
        /cannot be retried/u,
      );
      assert.equal(f.calls().length, mode === "stale" ? 2 : 1);
      assert.equal(f.budget.usage.requests, mode === "stale" ? 341 : 340);
      assert(f.budget.usage.bytes > 18743487);
    });
});
void test("quota refresh cannot spend reserved bytes expired runtime or active provider backoff", async (t) => {
  for (const mode of ["bytes", "time", "backoff"]) {
    const f = await quotaRefreshFixture(t);
    f.clock(f.now + 2000);
    if (mode === "bytes")
      f.budget.reserve = {
        requests: 0,
        bytes: f.budget.limits.bytes - f.budget.usage.bytes - 8192,
      };
    if (mode === "time") f.clock(f.now + f.budget.limits.milliseconds + 1);
    if (mode === "backoff") f.budget.retainBackoff(new Date(f.now + 60000).toISOString());
    await assert.rejects(() => f.project.request("POST /repos/o/r/issues", {}));
    assert.equal(f.calls().length, 0);
    assert.equal(f.budget.usage.requests, 339);
  }
});
