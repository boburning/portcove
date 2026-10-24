import { runPythonSuite } from "./python-test-results.mts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectAuthenticatedLinuxFixtureConfiguration,
  inspectAuthenticatedLinuxFixtureResult,
  inspectLinuxQualificationConfiguration,
} from "./qualify-semantic-linux.mts";
import { createHash } from "node:crypto";
import { requireDirectSemanticCapture } from "./release-semantic-runtime.mts";
import { spawnSync } from "node:child_process";
import { isRecord } from "./runtime-values.mts";

void test("Linux supervisor inert models run without namespace, provider, credential or native operations", (context) => {
  runPythonSuite(
    new URL("./semantic-review-linux-supervisor.test.py", import.meta.url),
    context,
    30000,
  );
});

void test("qualification configuration cannot select auth, reviewer mode, command or another backend", () => {
  const config = configuration();
  assert.equal(inspectLinuxQualificationConfiguration(config).output_parent, "/home/reviewer/q");
  for (const extra of [
    { auth_cache: "/home/reviewer/auth.json" },
    { mode: "codex" },
    { command: "sh" },
    { backend: "other" },
  ])
    assert.throws(() => inspectLinuxQualificationConfiguration({ ...config, ...extra }));
  assert.throws(() =>
    inspectLinuxQualificationConfiguration({ ...config, output_parent: "/home/../foreign" }),
  );
});

function configuration() {
  return {
    schema_version: 1,
    output_parent: "/home/reviewer/q",
    node_executable: "/opt/node",
    codex_executable: "/opt/codex",
    node_sha256: "a".repeat(64),
    codex_sha256: "b".repeat(64),
    supervisor_sha256: "c".repeat(64),
    tools_sha256: {
      python: "d".repeat(64),
      bwrap: "e".repeat(64),
      systemd_run: "f".repeat(64),
      systemctl: "0".repeat(64),
    },
  };
}

void test("authenticated inert configuration admits only the dedicated cache and fixed tools", () => {
  const config = { ...configuration(), auth_cache: "/home/reviewer/dedicated/auth.json" };
  assert.equal(inspectAuthenticatedLinuxFixtureConfiguration(config).auth_cache, config.auth_cache);
  assert.throws(() => inspectAuthenticatedLinuxFixtureConfiguration(configuration()));
  for (const extra of [
    { auth_cache: "relative/auth.json" },
    { auth_cache: "/home/reviewer/../auth.json" },
    { auth_cache: "/home/reviewer/./auth.json" },
    { auth_cache: "/home/reviewer/key.pem" },
    { auth_cache: null },
    { mode: "codex" },
    { command: "sh" },
    { backend: "other" },
  ])
    assert.throws(() => inspectAuthenticatedLinuxFixtureConfiguration({ ...config, ...extra }));
});

function settlement() {
  return {
    schema_version: 1,
    mode: "codex",
    authority: "none",
    scope: "held-linux-semantic-runtime-preparation",
    unit: `portcove-semantic-${"a".repeat(32)}.service`,
    storage_bytes: 512 * 1024 * 1024,
    memory_bytes: 1024 * 1024 * 1024,
    swap_bytes: 0,
    tasks_max: 64,
    cgroup_verified: true,
    namespaces_verified: true,
    capture_complete: true,
    cgroup_empty: true,
    unit_settled: true,
    network_settled: true,
    network_refused: false,
    forced_termination: false,
    auth_refreshed: true,
    exit_code: 0,
    failure: null,
    cleanup_errors: [],
  };
}

function events(withRead = true, final = { fixture: "inert" }) {
  const data = Buffer.from("inert fixture\n");
  const item = {
    id: "reader-1",
    type: "mcp_tool_call",
    server: "portcove_frozen_bundle",
    tool: "read",
    arguments: { snapshot: "source", path: "fixture.txt", offset: 0, length: 1024 },
  };
  return Buffer.from(
    [
      { type: "thread.started", thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      { type: "turn.started" },
      ...(withRead
        ? [
            { type: "item.started", item: { ...item, status: "in_progress" } },
            {
              type: "item.completed",
              item: {
                ...item,
                status: "completed",
                error: null,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        bytes: data.length,
                        offset: 0,
                        encoding: "base64",
                        next: null,
                        sha256: createHash("sha256").update(data).digest("hex"),
                        data: data.toString("base64"),
                      }),
                    },
                  ],
                },
              },
            },
          ]
        : []),
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(final) } },
      { type: "turn.completed" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
}

void test("authenticated fixture requires actual reader completion and full settlement, never semantic acceptance", () => {
  const value = inspectAuthenticatedLinuxFixtureResult(0, settlement(), events());
  assert.equal(value.authenticated, true);
  assert.equal(value.semantic_acceptance, false);
  assert.throws(() => requireDirectSemanticCapture(value as never), /imported/);
  assert.throws(() => inspectAuthenticatedLinuxFixtureResult(1, settlement(), events()));
  for (const extra of [
    { auth_refreshed: false },
    { cgroup_empty: false },
    { unit_settled: false },
    { network_settled: false },
    { capture_complete: false },
    { forced_termination: true },
    { mode: "codex-fixture" },
    { authority: "accepted" },
    { cleanup_errors: ["unknown"] },
  ])
    assert.throws(() =>
      inspectAuthenticatedLinuxFixtureResult(0, { ...settlement(), ...extra }, events()),
    );
  // Persisted auth is retained as an effect even if later fixture content refuses.
  assert.throws(() => inspectAuthenticatedLinuxFixtureResult(0, settlement(), events(false)));
  assert.throws(() =>
    inspectAuthenticatedLinuxFixtureResult(0, settlement(), events(true, { fixture: "other" })),
  );
  assert.throws(() => inspectAuthenticatedLinuxFixtureResult(0, settlement(), Buffer.from("{}")));
});

void test("actual qualifier CLI keeps auth in the supervisor and binds inert inputs and refusal", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    import * as fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import {createHash} from 'node:crypto';
    import {fileURLToPath} from 'node:url';
    const fixtureEvents = ${events.toString()};
    const fixtureSettlement = ${settlement.toString()};
    const source = ${JSON.stringify(new URL("./qualify-semantic-linux.mts", import.meta.url).href)};
    const resource = ${JSON.stringify(new URL("./resource-command.mts", import.meta.url).href)};
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authenticated-cli-'));
    const bytes = Buffer.from('inert executable only');
    const sha = b => createHash('sha256').update(b).digest('hex');
    const supervisor = fileURLToPath(new URL('./semantic-review-linux-supervisor.py', source));
    const fixed = new Set(['/inert/node', '/inert/codex', '/usr/bin/python3', '/usr/bin/bwrap', '/usr/bin/systemd-run', '/usr/bin/systemctl']);
    Object.defineProperty(process, 'platform', {value:'linux'});
    process.getuid = () => 1000;
    let scenario, launches = 0, authReads = 0;
    mock.module('node:fs/promises', {namedExports:{...fs,
      async readFile(file,...args) {
        if (String(file) === '/dedicated/auth.json') { authReads++; throw Error('credential read forbidden'); }
        if (fixed.has(String(file))) return bytes;
        return fs.readFile(file,...args);
      },
      async mkdtemp(prefix) { assert.equal(prefix, path.join('/inert-output','q-')); return fs.mkdtemp(path.join(root,'q-')); },
      async copyFile(file,destination) { assert.ok(fixed.has(String(file))); await fs.writeFile(destination,bytes); },
    }});
    mock.module(resource, {namedExports:{
      async reenterResourceCommand(profile) {assert.equal(profile,'analysis');},
      async runResourceCommand(profile, executable, args, options) {
        launches++;
        assert.equal(profile,'analysis'); assert.equal(executable,'/usr/bin/python3');
        assert.deepEqual(args.slice(0,3),['-I','-S','-B']); assert.equal(args[3],supervisor);
        assert.equal(args[4],'--request');
        for (const name of ['GH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY','CODEX_HOME']) assert.equal(options.environment[name],undefined);
        const request = JSON.parse(await fs.readFile(args[5],'utf8'));
        const legacy = scenario === 'legacy';
        assert.equal(request.mode,legacy ? 'codex-fixture' : 'codex');
        assert.equal(request.auth_cache,legacy ? null : '/dedicated/auth.json');
        assert.equal(request.timeout_seconds,legacy ? 120 : 300);
        const inputs = path.join(request.run_root,'inputs');
        const prompt = await fs.readFile(path.join(inputs,'instructions.txt'),'utf8');
        if (!legacy) { assert.match(prompt,/fixture.txt/); assert.match(prompt,/snapshot="source"/); assert.match(prompt,/never a release or semantic review/); }
        const indexBytes = await fs.readFile(path.join(inputs,'reader-index.json'));
        const index = JSON.parse(indexBytes);
        assert.equal(index.manifest.snapshots.source[0].path,'fixture.txt');
        assert.equal(Buffer.from(index.files[0].data,'base64').toString(),'inert fixture\\n');
        const launch = JSON.parse(await fs.readFile(path.join(inputs,'reader-launch.json'),'utf8'));
        assert.equal(launch.index_sha256,sha(indexBytes));
        for (const [name,digest] of Object.entries(request.inputs_sha256)) assert.equal(sha(await fs.readFile(path.join(inputs,name))),digest);
        const isolation = fixtureSettlement();
        if (legacy) { isolation.mode='codex-fixture'; isolation.auth_refreshed=false; }
        if (scenario === 'unsettled') isolation.cgroup_empty=false;
        await fs.writeFile(path.join(request.run_root,'capture/isolation.json'),JSON.stringify(isolation));
        await fs.writeFile(path.join(request.run_root,'capture/stdout.jsonl'),fixtureEvents(scenario !== 'wrong-reader'));
        return 0;
      },
    }});
    const config = {schema_version:1,output_parent:'/inert-output',node_executable:'/inert/node',codex_executable:'/inert/codex',
      node_sha256:sha(bytes),codex_sha256:sha(bytes),supervisor_sha256:sha(await fs.readFile(supervisor)),
      tools_sha256:Object.fromEntries(['python','bwrap','systemd_run','systemctl'].map(name=>[name,sha(bytes)]))};
    try {
      for (scenario of ['success','wrong-reader','unsettled','legacy']) {
        const configPath = path.join(root,scenario+'.json');
        await fs.writeFile(configPath,JSON.stringify(scenario === 'legacy' ? config : {...config,auth_cache:'/dedicated/auth.json'}));
        process.argv=[process.execPath,fileURLToPath(source),scenario === 'legacy' ? 'codex-fixture' : 'authenticated-fixture',configPath];
        const run=()=>import(source+'?scenario='+scenario);
        if (scenario === 'wrong-reader') await assert.rejects(run,/reader proof/);
        else if (scenario === 'unsettled') await assert.rejects(run,/positively settled/);
        else await run();
      }
      assert.equal(launches,4); assert.equal(authReads,0);
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  `,
    ],
    {
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 128 * 1024,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LANG: "C.UTF-8" },
    },
  );
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const results = child.stdout
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  assert.equal(results.length, 2);
  assert.ok(isRecord(results[0]));
  assert.ok(isRecord(results[1]));
  assert.equal(results[0].authenticated, true);
  assert.equal(results[0].semantic_acceptance, false);
  assert.equal(results[1].authenticated, false);
  assert.equal(results[1].mode, "codex-fixture");
});
