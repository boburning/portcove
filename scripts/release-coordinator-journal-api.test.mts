import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { createCoordinatorJournalApi } from "./release-coordinator-journal-api.mts";
import { performance } from "node:perf_hooks";

void test("journal transport shares one role deadline and refuses late write responses without retry", async (t) => {
  const root = await fixture(t);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "disposable-journal-only-secret";
  let clock = Math.floor(performance.now()),
    calls = 0;
  t.mock.method(performance, "now", () => clock);
  assert.throws(() => createCoordinatorJournalApi(root, clock - 1), /phase deadline/);
  assert.deepEqual(await readdir(root), []);
  t.mock.method(
    childProcess,
    "spawnSync",
    (_command: string, _args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls++;
      assert.equal(options.timeout, 1000);
      clock += 1001;
      return {
        status: 0,
        stdout: 'HTTP/2.0 201 Created\r\n\r\n{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
        stderr: "",
      };
    },
  );
  syncBuiltinESMExports();
  const api = createCoordinatorJournalApi(root, clock + 1000);
  assert.throws(
    () => api.request("POST", "repos/boburning/portcove/git/blobs", { content: "public" }),
    /phase deadline/,
  );
  assert.equal(calls, 1);
  assert.throws(() => api.request("GET", "repos/boburning/portcove"), /phase deadline/);
  assert.equal(calls, 1);
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "journal-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = [
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "PORTCOVE_COORDINATOR_JOURNAL_TOKEN",
    "HTTPS_PROXY",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ];
  const before = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return root;
}
void test("journal transport refuses provider-token fallback before any subprocess", async (t) => {
  const root = await fixture(t);
  delete process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN;
  process.env.GH_TOKEN = "provider-credential-must-not-authorize-journal";
  t.mock.method(childProcess, "spawnSync", () => assert.fail("no journal credential"));
  syncBuiltinESMExports();
  assert.throws(
    () => createCoordinatorJournalApi(root),
    /dedicated coordinator journal credential/u,
  );
  assert.deepEqual(await readdir(root), []);
});
void test("journal subprocess receives only its frozen dedicated credential and private configuration", async (t) => {
  const root = await fixture(t);
  const token = "disposable-journal-only-secret";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  process.env.GH_TOKEN = "provider-only-secret";
  process.env.GH_ENTERPRISE_TOKEN = "enterprise-secret";
  process.env.HTTPS_PROXY = "http://must-not-inherit.invalid";
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "oidc-secret";
  let calls = 0;
  t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
      calls++;
      assert.equal(command, "gh");
      assert.ok(options.env);
      assert.ok(typeof options.env.GH_CONFIG_DIR === "string");
      assert.deepEqual(args.slice(-2), ["--hostname", "github.com"]);
      assert.equal(options.env.GH_TOKEN, token);
      assert.equal(options.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN, undefined);
      assert.equal(options.env.GH_ENTERPRISE_TOKEN, undefined);
      assert.equal(options.env.HTTPS_PROXY, undefined);
      assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(options.env.GH_HOST, "github.com");
      assert.equal(path.dirname(options.env.GH_CONFIG_DIR), root);
      assert.equal(options.env.HOME, options.env.GH_CONFIG_DIR);
      assert.equal(options.env.APPDATA, options.env.GH_CONFIG_DIR);
      assert.equal(options.timeout, 15000);
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.equal(options.windowsHide, true);
      assert.equal(inspect(args).includes(token), false);
      return { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n{"ok":true}', stderr: "" };
    },
  );
  syncBuiltinESMExports();
  const api = createCoordinatorJournalApi(root);
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = "changed-after-construction";
  assert.deepEqual(api.request("GET", "repos/boburning/portcove").body, { ok: true });
  for (const [method, route] of [
    ["GET", "https://evil.invalid"],
    ["POST", "repos/boburning/portcove/git/refs"],
    ["GET", "repos/other/repo"],
    ["DELETE", "repos/boburning/portcove"],
  ] as const)
    assert.throws(() => api.request(method, route), /fixed repository/u);
  assert.equal(calls, 1);
  assert.equal(process.env.GH_TOKEN, "provider-only-secret");
});
void test("journal subprocess diagnostics redact its exact credential without losing timeout ambiguity", async (t) => {
  const root = await fixture(t);
  const token = "nonstandard-disposable-sensitive-value";
  process.env.PORTCOVE_COORDINATOR_JOURNAL_TOKEN = token;
  t.mock.method(childProcess, "spawnSync", () => ({
    status: 0,
    stdout: token,
    stderr: token,
    error: Object.assign(new Error(token), { code: "ETIMEDOUT" }),
  }));
  syncBuiltinESMExports();
  const api = createCoordinatorJournalApi(root);
  assert.throws(
    () =>
      api.request("POST", "repos/boburning/portcove/git/blobs", {
        content: "inert",
        encoding: "utf-8",
      }),
    (error: unknown) => {
      assert.equal(inspect(error, { depth: 10 }).includes(token), false);
      assert.match(String(error), /timed out/u);
      return true;
    },
  );
});
