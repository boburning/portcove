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
import { PassThrough } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import {
  bridgeMessages,
  serveHostBridge,
  probeLinuxCustody,
  verifyBridgedCapacity,
  verifyHostReference,
  acquireBridgedCapacity,
  bridgeLaunchArguments,
} from "./resource-host-bridge.mts";
import { readProcessIdentity } from "./heavy-rust-test-lock.mts";
import { verifyResourceRecoveryReference } from "./resource-paths.mts";

void test("maintenance admission owns every supported predecessor slot count", async (t) => {
  for (const slots of [1, 2, 4, 8]) {
    const root = await fixture(t);
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ slots, legacyMode: "coordinated" }),
    );
    const lease = await acquireResourceCapacity("maintenance", {}, isolated(root));
    try {
      assert.equal(lease.reference?.slots.length, slots);
      await assert.rejects(acquireResourceCapacity("analysis", {}, isolated(root, { waitMs: 0 })), {
        code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT",
      });
    } finally {
      await lease.release();
    }
  }
});

void test("pending recovery admits only a bound all-slot request and never overrides a live reservation", async (t) => {
  const root = await fixture(t),
    id = randomUUID();
  await mkdir(path.join(root, "migrations"));
  const file = path.join(root, "migrations", id + "-host-domain.json");
  const content = JSON.stringify({
    format: 1,
    id,
    linuxRoot: root,
    windowsNativeRoot: root,
    changes: Array.from({ length: 4 }, () => ({
      previous: JSON.stringify({ slots: 4 }),
      next: JSON.stringify({ slots: 1 }),
    })),
  });
  await writeFile(file, content);
  const reference = { file, sha256: createHash("sha256").update(content).digest("hex") };
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify({ slots: 4, legacyMode: "pending" }),
  );
  await assert.rejects(acquireResourceCapacity("analysis", {}, isolated(root, { waitMs: 0 })), {
    code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT",
  });
  await assert.rejects(
    acquireResourceCapacity("analysis", {}, isolated(root, { recoveryReceipt: reference })),
    /all-slot maintenance/u,
  );
  const controller = new AbortController();
  let ordinaryStarted = false;
  const ordinary = acquireResourceCapacity(
    "analysis",
    {},
    isolated(root, {
      waitMs: 5000,
      signal: controller.signal,
    }),
  ).then(async (lease) => {
    ordinaryStarted = true;
    await lease.release();
  });
  const cancelled = assert.rejects(ordinary, { name: "AbortError" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(path.join(root, "queue"))).length) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const lease = await acquireResourceCapacity(
    "maintenance",
    {},
    isolated(root, { recoveryReceipt: reference }),
  );
  try {
    assert.equal(lease.reference?.slots.length, 4);
    await assert.rejects(
      acquireResourceCapacity(
        "maintenance",
        {},
        isolated(root, { recoveryReceipt: reference, waitMs: 0 }),
      ),
      { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
    );
  } finally {
    await lease.release();
  }
  assert.equal(ordinaryStarted, false);
  controller.abort();
  await cancelled;
  await writeFile(file, content + " ");
  await assert.rejects(verifyResourceRecoveryReference(root, reference), /identity changed/u);
  await assert.rejects(
    verifyResourceRecoveryReference(root, { ...reference, file: path.join(root, "foreign.json") }),
    /outside this resource domain/u,
  );
});
void test("receipt-bound recovery verifies surplus predecessor slots after a partial reduction", async (t) => {
  for (const mode of ["pending", "coordinated"]) {
    const root = await fixture(t),
      id = randomUUID();
    await mkdir(path.join(root, "migrations"));
    const file = path.join(root, "migrations", id + "-host-domain.json");
    const content = JSON.stringify({
      format: 1,
      id,
      linuxRoot: root,
      windowsNativeRoot: root,
      changes: Array.from({ length: 4 }, () => ({
        previous: JSON.stringify({ slots: 2 }),
        next: JSON.stringify({ slots: 1 }),
      })),
    });
    await writeFile(file, content);
    await writeFile(path.join(root, "config.json"), JSON.stringify({ slots: 1, legacyMode: mode }));
    const settings = isolated(root, {
      waitMs: 0,
      recoveryReceipt: { file, sha256: createHash("sha256").update(content).digest("hex") },
    });
    const cleanup = path.join(root, "cleanup.json"),
      slot = path.join(root, "slot-1");
    const dead = { pid: 2147483647, identity: "absent-fixture-process" };
    const owner = {
      format_version: 1,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      process: dead,
      child: { ...dead, containment: "unix-watchdog", cleanup_receipt: cleanup },
    };
    await writeFile(slot, JSON.stringify(owner));
    await assert.rejects(acquireResourceCapacity("maintenance", {}, settings), {
      code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT",
    });
    assert.equal(record(JSON.parse(await readFile(slot, "utf8"))).token, owner.token);
    await writeFile(cleanup, JSON.stringify({ outcome: "quiescent" }));
    await writeFile(
      slot,
      JSON.stringify({
        ...owner,
        process: { pid: process.pid, identity: readProcessIdentity(process.pid)! },
      }),
    );
    await assert.rejects(acquireResourceCapacity("maintenance", {}, settings), {
      code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT",
    });
    await writeFile(slot, JSON.stringify(owner));
    const controller = new AbortController();
    let ordinaryStarted = false;
    const ordinary = acquireResourceCapacity(
      "analysis",
      {},
      isolated(root, {
        waitMs: 5000,
        pollMs: 5,
        report: () => {},
        signal: controller.signal,
      }),
    ).then(async (lease) => {
      ordinaryStarted = true;
      await lease.release();
    });
    const cancelled = assert.rejects(ordinary, { name: "AbortError" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await readdir(path.join(root, "queue"))).some((name) =>
          /^\d{13}-[a-f0-9-]{36}$/u.test(name),
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const lease = await acquireResourceCapacity("maintenance", {}, settings);
    assert.equal(ordinaryStarted, false);
    controller.abort();
    await cancelled;
    assert.equal(lease.reference?.slots.length, 2);
    await lease.release();
    await assert.rejects(readFile(slot), { code: "ENOENT" });
  }
});

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

const bridgeConfig = {
  closureSha256: "0".repeat(64),
  executable: "/mnt/z/tools/node.exe",
  script: "Z:\\owned\\resource-host-bridge.mts",
  distribution: "FixtureLinux",
  user: "developer",
  node: "/usr/bin/node",
  probe: "/owned/resource-host-bridge.mts",
};
function bridgeWrite(stream: PassThrough, value: object) {
  stream.write(JSON.stringify({ version: 1, ...value }) + "\n");
}

void test("host bridge shares the real FIFO engine and releases only on explicit prelaunch completion", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, "config.json"),
    JSON.stringify({ slots: 1, legacyMode: "coordinated" }),
  );
  const session = () => {
    const input = new PassThrough(),
      output = new PassThrough();
    const result = serveHostBridge(input, output, {
      root,
      probe: () => ({
        invocation: randomUUID(),
        owner: { pid: 1, identity: "linux:fixture" },
        child: null,
      }),
      acquire: (profile, metadata, options) =>
        acquireResourceCapacity(
          profile,
          metadata,
          isolated(root, { ...options, environment: {}, pollMs: 10, report: () => {} }),
        ),
    });
    const messages = bridgeMessages(output);
    const invocation = randomUUID();
    bridgeWrite(input, {
      action: "acquire",
      bridge: bridgeConfig,
      invocation,
      custodyFile: "/owned/custody.json",
      profile: "analysis",
      waitMs: 5000,
    });
    return { input, output, result, messages, invocation };
  };
  const first = session();
  assert.equal((await first.messages.next()).value?.action, "admitted");
  const second = session();
  let admitted = false;
  const next = second.messages.next().then((result) => {
    admitted = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(admitted, false);
  bridgeWrite(first.input, { action: "release" });
  assert.equal((await first.messages.next()).value?.action, "released");
  await first.result;
  assert.equal((await next).value?.action, "admitted");
  bridgeWrite(second.input, { action: "release" });
  assert.equal((await second.messages.next()).value?.action, "released");
  await second.result;
  first.input.end();
  first.output.end();
  second.input.end();
  second.output.end();
  assert.equal((await observeCapacity({ root })).running.length, 0);
});

void test("host bridge retains external reservations on lost connection and failed cleanup", async (t) => {
  const root = await fixture(t);
  for (const failure of ["connection", "cleanup"]) {
    const input = new PassThrough(),
      output = new PassThrough();
    let releases = 0,
      probes = 0,
      external: unknown;
    const invocation = randomUUID();
    const result = serveHostBridge(input, output, {
      root,
      acquire: async () => ({
        inherited: false,
        queueMs: 0,
        childEnvironment: {},
        reference: { root, slots: [{ name: "slot-0", token: invocation }] },
        registerChild: async () => undefined,
        registerExternal: async (value) => {
          external = value;
        },
        release: async () => {
          releases++;
        },
      }),
      probe: () => {
        if (++probes > 1) throw new Error("cleanup receipt missing");
        return { invocation, owner: { pid: 1, identity: "linux:original" }, child: null };
      },
    }).catch((error: unknown) => error);
    const messages = bridgeMessages(output);
    bridgeWrite(input, {
      action: "acquire",
      bridge: bridgeConfig,
      invocation,
      custodyFile: "/owned/custody.json",
      profile: "analysis",
      waitMs: 5000,
    });
    assert.equal((await messages.next()).value?.action, "admitted");
    if (failure === "cleanup") {
      bridgeWrite(input, { action: "register" });
      assert.equal((await messages.next()).value?.action, "registered");
      bridgeWrite(input, { action: "release" });
    } else input.end();
    assert.ok((await result) instanceof Error);
    assert.ok(external);
    assert.equal(releases, 0);
    input.end();
    output.end();
  }
});

void test("host bridge bounds wire input and refuses missing or foreign nested delegation", async () => {
  const input = new PassThrough();
  const result = bridgeMessages(input).next();
  input.end("x".repeat(32769));
  await assert.rejects(result, /exceeds bound/u);
  await assert.rejects(verifyBridgedCapacity(bridgeConfig, {}), /lacks host resource delegation/u);
  await assert.rejects(
    verifyHostReference({ reference: { root: "/foreign", slots: [] } }),
    /Invalid host resource delegation/u,
  );
});

void test(
  "host bridge Linux probe refuses changed custody, live children and missing cleanup",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await fixture(t);
    const file = path.join(root, "custody.json"),
      receipt = path.join(root, "cleanup.json");
    const stat = await import("node:fs/promises").then((fs) => fs.stat(root));
    const { chmod } = await import("node:fs/promises");
    await chmod(root, 0o700);
    const custody = {
      invocation: randomUUID(),
      owner: { pid: process.pid, identity: readProcessIdentity(process.pid)! },
      child: {
        pid: process.pid,
        identity: readProcessIdentity(process.pid)!,
        containment: "unix-watchdog",
        cleanup_receipt: receipt,
      },
      cleanupParent: { dev: stat.dev, ino: stat.ino },
    };
    await writeFile(file, JSON.stringify(custody));
    assert.equal(probeLinuxCustody(file, custody.invocation, "register").child?.pid, process.pid);
    assert.throws(() => probeLinuxCustody(file, randomUUID(), "register"), /invocation differs/u);
    assert.throws(() => probeLinuxCustody(file, custody.invocation, "release"), /ENOENT/u);
    await writeFile(receipt, JSON.stringify({ outcome: "quiescent" }));
    assert.throws(
      () => probeLinuxCustody(file, custody.invocation, "release"),
      /cleanup is not proven/u,
    );
    assert.throws(
      () =>
        probeLinuxCustody(file, custody.invocation, "release", {
          ...custody,
          invocation: randomUUID(),
        }),
      /evidence changed/u,
    );
    await writeFile(
      file,
      JSON.stringify({
        ...custody,
        child: { ...custody.child, pid: 2147483647, identity: "linux:absent" },
      }),
    );
    const stopped = probeLinuxCustody(file, custody.invocation, "release");
    assert.equal(stopped.child?.pid, 2147483647);
    await writeFile(file, JSON.stringify({ ...stopped, cleanupParent: { dev: 0, ino: 0 } }));
    assert.throws(
      () => probeLinuxCustody(file, custody.invocation, "release"),
      /directory identity changed/u,
    );
    await writeFile(file, JSON.stringify({ ...custody, child: null }));
    assert.throws(
      () => probeLinuxCustody(file, custody.invocation, "prelaunch-release"),
      /ENOENT/u,
    );
    await writeFile(
      path.join(root, "prelaunch-complete.json"),
      JSON.stringify({
        invocation: custody.invocation,
        owner: custody.owner.identity,
        outcome: "prelaunch-complete",
      }),
    );
    assert.equal(probeLinuxCustody(file, custody.invocation, "prelaunch-release").child, null);
  },
);

async function mockHost(t: TestContext, failure: string) {
  const root = await fixture(t);
  await mkdir(path.join(root, "scripts"));
  const entry = path.join(root, "scripts/mock.mjs"),
    closed = path.join(root, "closed.json");
  const source = [
    'import {writeFileSync} from "node:fs";',
    'const messages=[];let pending="";',
    "const timer=setTimeout(()=>process.exit(97),5000);",
    'process.stdin.setEncoding("utf8");',
    'for await (const chunk of process.stdin){pending+=chunk;let at;while((at=pending.indexOf("\\n"))!==-1){',
    "const m=JSON.parse(pending.slice(0,at));pending=pending.slice(at+1);messages.push(m);let action;",
    'if(m.action==="acquire")action=' +
      JSON.stringify(failure === "queue" ? "error" : "admitted") +
      ";",
    'else if(m.action==="register")action=' +
      JSON.stringify(failure === "register" ? "error" : "registered") +
      ";",
    'else if(m.action==="release")action="released";',
    'process.stdout.write(JSON.stringify({version:1,action,code:"PORTCOVE_RESOURCE_QUEUE_TIMEOUT",message:"fixture refusal",reference:{root:"fixture",slots:[{name:"slot-0",token:"fixture"}]}})+"\\n");',
    "}}clearTimeout(timer);writeFileSync(" + JSON.stringify(closed) + ",JSON.stringify(messages));",
  ].join("\n");
  await writeFile(entry, source);
  const manifest = JSON.stringify({
    format: 1,
    runtime: process.version,
    files: [
      {
        path: "scripts/mock.mjs",
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    ],
  });
  await writeFile(path.join(root, "bridge-manifest.json"), manifest);
  const config = {
    ...bridgeConfig,
    executable: process.execPath,
    script: entry,
    closureSha256: createHash("sha256").update(manifest).digest("hex"),
  };
  return {
    config,
    root,
    entry,
    closed,
    close: async () => {
      const end = performance.now() + 3000;
      while (performance.now() < end) {
        try {
          const events: unknown = JSON.parse(await readFile(closed, "utf8"));
          assert.ok(Array.isArray(events));
          const acquire: unknown = events[0];
          assert.ok(isRecord(acquire) && typeof acquire.custodyFile === "string");
          t.after(() =>
            rm(path.dirname(acquire.custodyFile as string), { recursive: true, force: true }),
          );
          const observations: unknown[] = events;
          return observations;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("the actual host helper did not exit after client failure");
    },
  };
}

void test("host bridge actual client preserves queue refusal and rejects changed verifier bytes", async (t) => {
  const host = await mockHost(t, "queue");
  let localAcquisitions = 0;
  await assert.rejects(
    acquireBridgedCapacity(host.config, "analysis", {}, { waitMs: 0 }, async () => {
      localAcquisitions++;
      throw new Error("must not acquire locally");
    }),
    { code: "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" },
  );
  assert.equal(localAcquisitions, 0);
  await host.close();
  await writeFile(host.entry, "throw Error('unbound replacement executed');");
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        bridgeLaunchArguments(host.entry, host.config.closureSha256, "--host"),
        { encoding: "utf8", timeout: 5000, stdio: "pipe" },
      ),
    /Bridge module identity differs/u,
  );
});

void test(
  "host bridge actual client closes its helper on register ACK loss and release-probe failure",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const failure of ["register", "release"]) {
      const host = await mockHost(t, failure);
      let released = 0;
      const lease = await acquireBridgedCapacity(
        host.config,
        "analysis",
        {},
        { waitMs: 1000 },
        async () => ({
          inherited: false,
          queueMs: 0,
          childEnvironment: {},
          registerChild: async () => ({
            pid: process.pid,
            identity: readProcessIdentity(process.pid)!,
            containment: "unix-watchdog",
            cleanup_receipt: path.join(host.root, "missing-cleanup.json"),
          }),
          release: async () => {
            released++;
          },
        }),
      );
      if (failure === "register")
        await assert.rejects(lease.registerChild({ pid: process.pid }), /fixture refusal/u);
      else {
        await lease.registerChild({ pid: process.pid });
        const first = lease.release();
        assert.equal(lease.release(), first);
        await assert.rejects(first, /ENOENT/u);
      }
      await host.close();
      assert.equal(released, 0);
    }
  },
);

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
      "development-scratch.mts",
      "node-test-suites.mts",
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
  const controller = new AbortController();
  const observed = Promise.withResolvers<void>();
  const transition = Promise.withResolvers<void>();
  const pending = acquireResourceCapacity(
    "rust",
    {},
    isolated(root, {
      pollMs: 25,
      signal: controller.signal,
      report: () => {},
      legacyBlocker: async () => {
        // The ordinary config reader has closed before this existing seam.
        // Pause one poll so the fixture's atomic handover cannot race that
        // Windows file handle. Admission still observes the real next config.
        observed.resolve();
        await transition.promise;
        return null;
      },
    }),
  );
  try {
    await Promise.race([
      observed.promise,
      pending.then(() => assert.fail("Pending handover must not admit payloads")),
    ]);
    assert.equal((await readdir(path.join(root, "queue"))).length, 1);
    assert.equal((await observeCapacity({ root })).running.length, 0);
    const nextConfig = path.join(root, "config-next.json");
    await writeFile(nextConfig, JSON.stringify({ legacyMode: "coordinated" }), { flag: "wx" });
    await rename(nextConfig, path.join(root, "config.json"));
    transition.resolve();
    const lease = await pending;
    assert.equal(lease.inherited, false);
  } finally {
    // Even failed transition/assertions must drain this owned asynchronous
    // admission before the fixture's registered directory cleanup.
    transition.resolve();
    controller.abort();
    const [settled] = await Promise.allSettled([pending]);
    if (settled?.status === "fulfilled") await settled.value.release();
  }
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
