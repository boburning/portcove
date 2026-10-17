import type { TestContext } from "node:test";
import type { ResourceCapacityOptions } from "./resource-capacity.mts";
import { isRecord } from "./runtime-values.mts";
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
interface WorkerEvent {
  kind: string;
  at: number;
  queueMs?: unknown;
  reference?: unknown;
  code?: unknown;
}
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  copyFile,
  rename,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireResourceCapacity,
  acquireSourceBoundCapacity,
  frontendOutputResource,
  reconcileExternalCapacity,
  observeCapacity,
  resourceDomainRoot,
  resourceConfiguration,
} from "./resource-capacity.mts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "config.json"), JSON.stringify({ legacyMode: "coordinated" }));
  return root;
}
const isolated = (
  root: string,
  extra: Partial<ResourceCapacityOptions> = {},
): ResourceCapacityOptions => ({
  root,
  environment: {},
  legacyBlocker: async () => null,
  ...extra,
});

void test("host identity ignores worktree and writable tool-cache overrides", async (t) => {
  const root = await fixture(t);
  const domains = [];
  for (const name of ["checkout-a", "checkout-b"]) {
    const checkout = path.join(root, name);
    await mkdir(path.join(checkout, "scripts"), { recursive: true });
    for (const file of [
      "runtime-values.mts",
      "resource-capacity.mts",
      "resource-paths.mts",
      "heavy-rust-test-lock.mts",
      "process-lock.mts",
      "tool-cache.mts",
      "fallow-source.mts",
      "dev-storage.mts",
    ])
      await copyFile(new URL(`./${file}`, import.meta.url), path.join(checkout, "scripts", file));
    domains.push(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {resourceDomainRoot} from './scripts/resource-capacity.mts'; console.log(resourceDomainRoot())",
        ],
        {
          cwd: checkout,
          env: {
            ...process.env,
            PORTCOVE_SHARED_TOOL_CACHE: path.join(root, name, "different-cache"),
          },
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      ).trim(),
    );
  }
  assert.equal(domains[0], resourceDomainRoot());
  assert.equal(domains[1], domains[0]);
  await writeFile(path.join(root, "config.json"), JSON.stringify({ slots: 0 }));
  await assert.rejects(resourceConfiguration(root), /slots 1\.\.8/);
});

void test("verified nesting reuses capacity and refuses a partial upgrade", async (t) => {
  const root = await fixture(t);
  const outer = await acquireResourceCapacity("browser", { workspace: "outer" }, isolated(root));
  try {
    const nested = await acquireResourceCapacity(
      "analysis",
      {},
      isolated(root, { environment: outer.childEnvironment }),
    );
    assert.equal(nested.inherited, true);
    await nested.release();
    assert.equal((await observeCapacity({ root })).running.length, 1);
    await assert.rejects(
      acquireResourceCapacity(
        "container",
        {},
        isolated(root, { environment: outer.childEnvironment }),
      ),
      /upgrade refused/,
    );
    const stale = record(JSON.parse(text(outer.childEnvironment.PORTCOVE_RESOURCE_RESERVATION)));
    assert.ok(Array.isArray(stale.slots));
    record((stale.slots as unknown[])[0]).token = "wrong-owner";
    await assert.rejects(
      acquireResourceCapacity(
        "browser",
        {},
        isolated(root, { environment: { PORTCOVE_RESOURCE_RESERVATION: JSON.stringify(stale) } }),
      ),
      /verified live ownership/,
    );
  } finally {
    await outer.release();
  }
  assert.equal((await observeCapacity({ root })).running.length, 0);
});

function worker(t: TestContext, root: string, profile: string, workspace: string) {
  const script = `
    import {acquireResourceCapacity} from ${JSON.stringify(new URL("./resource-capacity.mts", import.meta.url).href)};
    const abort = new AbortController();
    process.on('SIGTERM',()=>abort.abort());
    process.on('message', message=>{if(message==='cancel')abort.abort();});
    let lease;
    try {
      process.send({kind:'request',at:Date.now()});
      lease=await acquireResourceCapacity(${JSON.stringify(profile)},{workspace:${JSON.stringify(workspace)},command:'bounded fixture'},
        {root:${JSON.stringify(root)},environment:{},signal:abort.signal,legacyBlocker:async()=>null,pollMs:25});
      process.send({kind:'admit',at:Date.now(),queueMs:lease.queueMs,reference:lease.reference});
      await new Promise(resolve=>process.once('message',resolve));
      process.send({kind:'end',at:Date.now()});
    } catch(error) { process.send({kind:'cancel',at:Date.now(),code:error.code??error.name}); }
    finally { if(lease)await lease.release(); process.disconnect(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workspace,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  const events: WorkerEvent[] = [];
  const waiters: (() => void)[] = [];
  let stderr = "";
  assert.ok(child.stderr);
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  child.on("message", (event) => {
    assert.ok(isRecord(event) && typeof event.kind === "string" && typeof event.at === "number");
    events.push({ ...event, kind: event.kind, at: event.at });
    for (const waiter of waiters.splice(0)) waiter();
  });
  const closed = new Promise((resolve) => child.once("close", (code) => resolve({ code, stderr })));
  t.after(async () => {
    if (child.connected) child.send("cancel");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }, 2000);
    await closed;
    clearTimeout(force);
  });
  return {
    child,
    events,
    closed,
    async wait(kind: string) {
      while (!events.some((event) => event.kind === kind))
        await new Promise<void>((resolve) => waiters.push(resolve));
      const event = events.find((event) => event.kind === kind);
      assert.ok(event);
      return event;
    },
  };
}

void test("cross-process cross-category capacity queues, cancels, progresses and leaves lightweight work free", async (t) => {
  const root = await fixture(t);
  const workspaces = [path.join(root, "one"), path.join(root, "two")] as const;
  for (const workspace of workspaces) await mkdir(workspace);
  const container = worker(t, root, "container", workspaces[0]);
  await container.wait("admit");
  const rust = worker(t, root, "rust", workspaces[1]);
  const browser = worker(t, root, "browser", workspaces[1]);
  await rust.wait("request");
  await browser.wait("request");
  assert.equal(
    execFileSync(process.execPath, ["-e", "process.stdout.write('lightweight')"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }),
    "lightweight",
  );
  // Wait until both requests are actually published, not just process startup.
  for (;;) {
    if ((await readdir(path.join(root, "queue"))).length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(!rust.events.some((event) => event.kind === "admit"));
  assert(!browser.events.some((event) => event.kind === "admit"));
  rust.child.send("cancel");
  await rust.closed;
  container.child.send("release");
  const ended = await container.wait("end");
  await container.closed;
  const admitted = await browser.wait("admit");
  assert(admitted.at >= ended.at);
  assert(typeof admitted.queueMs === "number" && admitted.queueMs > 0);
  browser.child.send("release");
  await browser.closed;
  const observation = await observeCapacity({ root });
  assert.equal(observation.running.length, 0);
  assert.equal(observation.queued.filter((entry) => entry.activity).length, 0);
});

void test("two ordinary heavy profiles overlap while a third waits", async (t) => {
  const root = await fixture(t);
  const one = worker(t, root, "rust", root);
  const first = await one.wait("admit");
  const two = worker(t, root, "browser", root);
  const second = await two.wait("admit");
  assert(second.at >= first.at);
  assert(!one.events.some((event) => event.kind === "end"));
  const third = worker(t, root, "analysis", root);
  await third.wait("request");
  one.child.send("release");
  const end = await one.wait("end");
  await one.closed;
  const admitted = await third.wait("admit");
  assert(admitted.at >= end.at);
  two.child.send("release");
  third.child.send("release");
  await Promise.all([two.closed, third.closed]);
});

void test("queue timeout is admission failure and external work is never reclaimed by age or absent PID", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "slot-0"),
    JSON.stringify({
      format_version: 1,
      token: "remote",
      process: { pid: 999999, identity: "absent" },
      child: null,
      created_at: "2020-01-01T00:00:00.000Z",
      workspace: "preserved",
      command: "Docker daemon work",
    }),
  );
  await writeFile(
    path.join(root, "slot-0.external-remote"),
    JSON.stringify({ kind: "docker", run: "exact-run" }),
  );
  await writeFile(path.join(root, "config.json"), JSON.stringify({ slots: 1 }));
  const bytes = await readFile(path.join(root, "slot-0"), "utf8");
  await assert.rejects(
    acquireResourceCapacity("rust", {}, isolated(root, { waitMs: 0, report: () => {} })),
    { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
  );
  assert.equal(await readFile(path.join(root, "slot-0"), "utf8"), bytes);
  assert.deepEqual(await readdir(path.join(root, "queue")), []);
});

void test("output ownership rolls back partial capacity and source changes after queue refuse execution", async (t) => {
  const root = await fixture(t);
  const output = frontendOutputResource(root);
  const first = await acquireResourceCapacity(
    "browser",
    {},
    isolated(root, { exclusive: [output] }),
  );
  await assert.rejects(
    acquireResourceCapacity("analysis", {}, isolated(root, { exclusive: [output], waitMs: 0 })),
    { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
  );
  assert.equal((await observeCapacity({ root })).running.length, 1);
  let source = "before";
  const pending = acquireSourceBoundCapacity(
    "browser",
    { workspace: root },
    isolated(root, {
      exclusive: [output],
      snapshot: () => source,
      report: () => {},
      pollMs: 25,
    }),
  );
  while (!(await readdir(path.join(root, "queue"))).length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  source = "after";
  await first.release();
  await assert.rejects(pending, { code: "PORTCOVE_RESOURCE_SOURCE_CHANGED" });
  assert.equal((await observeCapacity({ root })).running.length, 0);
});

void test("external recovery is proof-bound and resumes partial release without touching successors", async (t) => {
  const root = await fixture(t);
  const lease = await acquireResourceCapacity("container", {}, isolated(root));
  const external = { kind: "docker", run: "owned-fixture" };
  assert.ok(lease.registerExternal);
  assert.ok(lease.reference);
  await lease.registerExternal(external);
  const original = [];
  for (const slot of lease.reference.slots) {
    const file = path.join(root, slot.name);
    const owner = record(JSON.parse(await readFile(file, "utf8")));
    owner.process = { pid: 999999, identity: "positively-absent-fixture" };
    const bytes = JSON.stringify(owner);
    await writeFile(file, bytes);
    original.push({ slot, bytes });
  }
  await assert.rejects(
    reconcileExternalCapacity(lease.reference, external, async () => false, { root }),
    /not proven stopped/,
  );
  await reconcileExternalCapacity(lease.reference, external, async () => true, { root });
  // Reconstitute precisely the interrupted-release state: first slot gone, second
  // original token still present. The durable decision already exists.
  const retained = original[1];
  assert.ok(retained);
  await writeFile(path.join(root, retained.slot.name), retained.bytes);
  await writeFile(
    path.join(root, `${retained.slot.name}.external-${retained.slot.token}`),
    JSON.stringify(external),
  );
  const successor = await acquireResourceCapacity("analysis", {}, isolated(root));
  const successorSlot = successor.reference?.slots[0];
  assert.ok(successorSlot);
  const before = await readFile(path.join(root, successorSlot.name), "utf8");
  await reconcileExternalCapacity(lease.reference, external, async () => true, { root });
  assert.equal(await readFile(path.join(root, successorSlot.name), "utf8"), before);
  assert.equal((await observeCapacity({ root })).running.length, 1);
  await successor.release();
});

void test("pending handover queues new payloads without acquiring retirement guards", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "config.json"), JSON.stringify({ legacyMode: "pending" }));
  await assert.rejects(
    acquireResourceCapacity("browser", {}, isolated(root, { waitMs: 0, report: () => {} })),
    { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
  );
  assert.equal((await observeCapacity({ root })).running.length, 0);
  assert.deepEqual(await readdir(path.join(root, "queue")), []);
  const pending = acquireResourceCapacity(
    "rust",
    {},
    isolated(root, { pollMs: 25, report: () => {} }),
  );
  while (!(await readdir(path.join(root, "queue"))).length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const nextConfig = path.join(root, "config-next.json");
  await writeFile(nextConfig, JSON.stringify({ legacyMode: "coordinated" }), { flag: "wx" });
  await rename(nextConfig, path.join(root, "config.json"));
  const lease = await pending;
  assert.equal(lease.inherited, false);
  await lease.release();
});

void test("unavailable process identity waits conservatively and never becomes capacity", async (t) => {
  const root = await fixture(t);
  const messages: string[] = [];
  let probes = 0;
  const unavailable = () =>
    Object.assign(new Error("fixture identity probe timed out"), {
      code: "PORTCOVE_PROCESS_IDENTITY_UNAVAILABLE",
    });
  const lease = await acquireResourceCapacity(
    "browser",
    {},
    isolated(root, {
      pollMs: 10,
      waitMs: 1000,
      report: (value) => messages.push(value),
      legacyBlocker: async () => {
        if (++probes < 3) throw unavailable();
        return null;
      },
    }),
  );
  assert.equal(probes, 3);
  assert.ok(lease.queueMs >= 20);
  assert.match(messages.join("\n"), /verified process identity/);
  await lease.release();
  await assert.rejects(
    acquireResourceCapacity(
      "browser",
      {},
      isolated(root, {
        pollMs: 10,
        waitMs: 30,
        report: () => {},
        legacyBlocker: async () => {
          throw unavailable();
        },
      }),
    ),
    { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
  );
  assert.equal((await observeCapacity({ root })).running.length, 0);
  assert.deepEqual(await readdir(path.join(root, "queue")), []);
});

void test("resource configuration rejects primitives and source admission requires a workspace", async (t) => {
  const root = await fixture(t);
  for (const invalid of [null, [], true, 7, "defaults"]) {
    await writeFile(path.join(root, "config.json"), JSON.stringify(invalid));
    await assert.rejects(resourceConfiguration(root), /must be an object/);
  }
  await writeFile(path.join(root, "config.json"), JSON.stringify({ legacyMode: "coordinated" }));
  await assert.rejects(
    acquireSourceBoundCapacity("analysis", {}, isolated(root)),
    /requires a workspace/,
  );
  assert.equal((await observeCapacity({ root })).running.length, 0);
});
