import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";
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
import { GitHubApiError } from "./github-api.mts";
import { renameSync, readdirSync } from "node:fs";
import * as discoverySession from "./daily-discovery-session.mts";
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
void test("bootstrap identity covers the complete statically loaded module closure", () => {
  const entry = new URL("./daily-discovery.mts", import.meta.url);
  const source = readFileSync(entry, "utf8");
  const declaration = source.match(/const bootstrap = \[([\s\S]*?)\];/u);
  assert.ok(declaration, "bootstrap identity list is present");
  const bound = [...declaration[1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
  // The maintained production bootstrap list remains the independent expectation.
  // Later imports belong to the separately captured runner/execution inputs.
  const loaded = readFixtureModuleClosure(
    path.dirname(fileURLToPath(entry)),
    ["daily-discovery.mts"],
    {
      includeDynamicImports: false,
    },
  ).modules.map((module) => module.path);
  assert.deepEqual([...new Set(bound)].sort(), loaded.sort());
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
  const source = readFileSync(new URL("./roadmap.mts", import.meta.url), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const start = source.indexOf(
    "  const roadmapErrors = [",
    source.indexOf("export function evaluateRoadmapDoctor"),
  );
  const end = source.indexOf("  return { warnings: stage.warnings", start);
  assert.ok(start > 0 && end > start);
  // bb8203480d95671feec0f866bfc5f87353a8a667 scripts/roadmap.mts:
  // SHA256 b111e77b459682965cdf8fcc1f646aa3b71faf414aebda11fdc2c03208ebb246.
  // The oracle was pinned and separately reviewed before extraction (#2100).
  assert.equal(
    createHash("sha256").update(source.slice(start, end)).digest("hex"),
    "7900795d2bccebf5a731f877e43f0827968a1f0ac7fab4da345cfa6ed511c967",
  );
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
