// The standalone ordinary Linux package case must not use WebKit automation:
// WebKitGTK grants automated media requests before its normal permission path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const scriptLimit = 10_000;

async function bounded(operation, deadline, label) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, `${label} deadline`);
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} deadline`)), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function linuxInspectorEnvironment(environment, port) {
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const result = { ...environment };
  delete result.TAURI_WEBVIEW_AUTOMATION;
  delete result.WEBKIT_INSPECTOR_SERVER;
  result.WEBKIT_INSPECTOR_HTTP_SERVER = `127.0.0.1:${port}`;
  return result;
}

export function inspectorSocketPath(html) {
  assert.ok(Buffer.byteLength(html) <= 65_536, "Bounded inspector discovery document");
  const tuples = [...html.matchAll(/\/socket\/(\d+)\/(\d+)\/WebPage/gu)];
  const paths = [...new Set(tuples.map((match) => `/socket/${match[1]}/${match[2]}/WebPage`))];
  assert.equal(paths.length, 1, "Exactly one ordinary application WebPage is required");
  for (const value of paths[0].split("/").slice(2, 4)) {
    assert.match(value, /^[1-9]\d{0,19}$/u, "Canonical inspector target identity");
    assert.ok(BigInt(value) <= 0xffffffffffffffffn);
  }
  return paths[0];
}

export function isInspectorMainDocument(document) {
  return (
    ["tauri://localhost", "tauri://localhost/"].includes(document.url) &&
    document.label === "main" &&
    document.webdriver === false
  );
}

async function processIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { pid: Number(pid), parent: Number(fields[1]), start_ticks: fields[19] };
}

async function listenerIdentity({ port, launch, app, expectedSha256 }, deadline) {
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const rows = (await readFile("/proc/net/tcp", "utf8"))
    .trim()
    .split("\n")
    .slice(1)
    .map((row) => row.trim().split(/\s+/u));
  const listeners = rows.filter((row) => row[1] === address && row[3] === "0A");
  assert.equal(listeners.length, 1, "Exactly one loopback inspector listener");
  const inode = listeners[0][9];
  const processes = new Map();
  const owners = [];
  const pids = (await readdir("/proc")).filter((value) => /^\d+$/u.test(value));
  assert.ok(pids.length <= 4096, "Bounded namespace process inventory");
  for (const pid of pids) {
    assert.ok(Date.now() < deadline, "Listener inventory deadline");
    try {
      const identity = await processIdentity(pid);
      processes.set(identity.pid, identity);
      const descriptors = await readdir(`/proc/${pid}/fd`);
      assert.ok(descriptors.length <= 4096, "Bounded process descriptor inventory");
      for (const descriptor of descriptors) {
        const link = await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => null);
        if (link === `socket:[${inode}]`) {
          owners.push(identity);
          break;
        }
      }
    } catch {
      // Departed or inaccessible unrelated processes cannot supply ownership.
    }
  }
  assert.equal(owners.length, 1, "Inspector listener process attribution is required");
  const owner = owners[0];
  let ancestor = owner.pid;
  const seen = new Set();
  while (ancestor !== launch.child.pid) {
    assert.ok(!seen.has(ancestor) && processes.has(ancestor), "Owned launch ancestry required");
    seen.add(ancestor);
    ancestor = processes.get(ancestor).parent;
  }
  const executable = await realpath(`/proc/${owner.pid}/exe`);
  assert.equal(executable, await realpath(app));
  assert.equal(await sha256(`/proc/${owner.pid}/exe`), expectedSha256);
  const namespace = await readlink(`/proc/${owner.pid}/ns/pid`);
  const namespaces = Object.fromEntries(
    await Promise.all(
      ["user", "mnt", "pid"].map(async (name) => [
        name,
        await readlink(`/proc/${owner.pid}/ns/${name}`),
      ]),
    ),
  );
  const status = await readFile(`/proc/${owner.pid}/status`, "utf8");
  const namespacePids = status
    .match(/^NSpid:\s+([\d\s]+)$/mu)?.[1]
    .trim()
    .split(/\s+/u)
    .map(Number);
  assert.ok(
    namespacePids?.length && namespacePids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
  );
  assert.notEqual(namespace, await readlink("/proc/self/ns/pid"));
  assert.deepEqual(await processIdentity(owner.pid), owner, "Listener generation must remain live");
  return {
    ...owner,
    inode,
    executable,
    sha256: expectedSha256,
    namespace,
    namespaces,
    namespace_pid: namespacePids.at(-1),
  };
}

async function discoveryDocument(port, deadline) {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
  });
  assert.ok(response.ok);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await bounded(reader.read(), deadline, "Inspector discovery");
      if (item.done) break;
      bytes += item.value.length;
      assert.ok(bytes <= 65_536, "Bounded inspector discovery body");
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    await bounded(reader.cancel(), deadline, "Inspector discovery cleanup");
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Exported for protocol controls in the adjacent native contract suite. It does
// not launch applications or confer ownership; connectLinuxInspector does that.
export class LinuxInspectorProtocol {
  constructor(socket, report) {
    this.socket = socket;
    this.report = report;
    this.pending = new Map();
    this.outer = new Map();
    this.nextId = 0;
    this.frames = 0;
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("error", () => this.fail(new Error("Inspector socket error")));
    socket.addEventListener("close", () => this.fail(new Error("Inspector socket closed")));
  }

  fail(error) {
    this.failure ??= error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.outer.clear();
  }

  receive(data) {
    try {
      assert.equal(typeof data, "string");
      assert.ok(Buffer.byteLength(data) <= 8 * 1024 * 1024, "Bounded inspector frame");
      assert.ok(++this.frames <= 4096, "Bounded inspector event count");
      const message = JSON.parse(data);
      if (message.method === "Target.targetCreated") {
        const target = message.params.targetInfo;
        if (target.type === "page" && !target.isProvisional) {
          assert.ok(!this.target || this.target === target.targetId, "Main target must not change");
          this.target = target.targetId;
        }
      } else if (message.method === "Target.targetDestroyed") {
        assert.notEqual(message.params.targetId, this.target, "Main target was destroyed");
      } else if (message.method === "Target.dispatchMessageFromTarget") {
        assert.equal(message.params.targetId, this.target, "Reply must belong to the main target");
        const nested = JSON.parse(message.params.message);
        const entry = this.pending.get(nested.id);
        if (entry) {
          if (nested.error) entry.reject(new Error(JSON.stringify(nested.error)));
          else entry.resolve(nested.result);
        }
      } else if (message.id && message.error && this.outer.has(message.id)) {
        this.pending
          .get(this.outer.get(message.id))
          ?.reject(new Error(JSON.stringify(message.error)));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async command(method, parameters, deadline) {
    if (this.failure) throw this.failure;
    assert.ok(this.target, "Main inspector target is required");
    assert.ok(this.pending.size < 8, "Bounded outstanding inspector operations");
    const innerId = ++this.nextId;
    const outerId = ++this.nextId;
    try {
      const result = new Promise((resolve, reject) =>
        this.pending.set(innerId, { resolve, reject }),
      );
      this.outer.set(outerId, innerId);
      this.socket.send(
        JSON.stringify({
          id: outerId,
          method: "Target.sendMessageToTarget",
          params: {
            targetId: this.target,
            message: JSON.stringify({ id: innerId, method, params: parameters }),
          },
        }),
      );
      return await bounded(result, deadline, method);
    } finally {
      this.pending.delete(innerId);
      this.outer.delete(outerId);
    }
  }

  async evaluatePromise(expression, deadline) {
    let result = await this.command(
      "Runtime.evaluate",
      { expression, returnByValue: false },
      deadline,
    );
    assert.notEqual(result.wasThrown, true, "Inspector script threw");
    // WebKit's RemoteObject has no CDP-style promise subtype. Both callers
    // create a real Promise; awaitPromise independently checks its native type.
    assert.equal(result.result.type, "object");
    assert.equal(result.result.className, "Promise");
    assert.equal(typeof result.result.objectId, "string");
    result = await this.command(
      "Runtime.awaitPromise",
      {
        promiseObjectId: result.result.objectId,
        returnByValue: true,
      },
      deadline,
    );
    assert.notEqual(result.wasThrown, true, "Inspector callback rejected");
    if (result.result.type === "undefined") return undefined;
    assert.ok(Object.hasOwn(result.result, "value"), "A serialized script result is required");
    return result.result.value;
  }

  executeScript(script, ...args) {
    assert.equal(typeof script, "function");
    return this.evaluatePromise(
      `Promise.resolve().then(()=>(${script.toString()})(...${JSON.stringify(args)}))`,
      Date.now() + scriptLimit,
    );
  }

  executeAsyncScript(script, ...args) {
    assert.equal(typeof script, "function");
    const expression = `new Promise((resolve,reject)=>{try{(${script.toString()})(...${JSON.stringify(args)},resolve)}catch(error){reject(error)}})`;
    return this.evaluatePromise(expression, Date.now() + scriptLimit);
  }

  getCurrentUrl() {
    return this.executeScript(() => location.href);
  }

  manage() {
    return {
      setTimeouts: async (values) => {
        assert.ok(Object.keys(values).every((key) => ["script", "pageLoad"].includes(key)));
        for (const value of Object.values(values)) assert.equal(value, scriptLimit);
      },
    };
  }

  async wait(predicate, milliseconds) {
    assert.equal(typeof predicate, "function");
    assert.ok(Number.isInteger(milliseconds) && milliseconds > 0 && milliseconds <= 30_000);
    const deadline = Date.now() + milliseconds;
    do {
      if (await bounded(Promise.resolve().then(predicate), deadline, "Main document readiness"))
        return true;
      await pause(Math.max(1, Math.min(100, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new Error("Main document readiness deadline");
  }

  async takeScreenshot() {
    const viewport = await this.executeScript(() => ({ width: innerWidth, height: innerHeight }));
    for (const value of Object.values(viewport))
      assert.ok(Number.isInteger(value) && value > 0 && value <= 4096);
    const result = await this.command(
      "Page.snapshotRect",
      {
        x: 0,
        y: 0,
        ...viewport,
        coordinateSystem: "Viewport",
      },
      Date.now() + scriptLimit,
    );
    assert.match(result.dataURL, /^data:image\/png;base64,/u);
    const data = result.dataURL.slice("data:image/png;base64,".length);
    assert.match(data, /^[A-Za-z0-9+/]+={0,2}$/u);
    assert.equal(Buffer.from(data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    return data;
  }

  async quit() {
    this.report.frames = this.frames;
    this.report.closed_at = new Date().toISOString();
    this.socket.close();
    this.fail(new Error("Inspector observer closed; application custody is separate"));
  }
}

export async function connectLinuxInspector({
  port,
  launch,
  app,
  expectedSha256,
  evidence,
  beforeConnect,
}) {
  assert.equal(process.platform, "linux");
  const report = {
    transport: "WebKit WebPage inspector",
    automation: false,
    started_at: new Date().toISOString(),
    discovery: [],
  };
  let browser;
  let originalFailure;
  try {
    const deadline = Date.now() + 20_000;
    if (beforeConnect)
      await bounded(beforeConnect(deadline), deadline, "Application media readiness");
    while (!report.listener) {
      try {
        report.listener = await bounded(
          listenerIdentity({ port, launch, app, expectedSha256 }, deadline),
          deadline,
          "Listener attribution",
        );
      } catch (error) {
        if (Date.now() >= deadline || launch.child.exitCode !== null) throw error;
        await pause(100);
      }
    }
    let socketPath;
    while (!socketPath) {
      const html = await discoveryDocument(port, deadline);
      report.discovery.push({ at: new Date().toISOString(), bytes: Buffer.byteLength(html) });
      assert.ok(report.discovery.length <= 100);
      if (/\/socket\/\d+\/\d+\/WebPage/u.test(html)) socketPath = inspectorSocketPath(html);
      else {
        assert.ok(Date.now() < deadline, "Main WebPage discovery deadline");
        await pause(100);
      }
    }
    const verifyListener = async () => {
      if (browser?.failure) throw browser.failure;
      const limit = Date.now() + scriptLimit;
      assert.deepEqual(
        await bounded(
          listenerIdentity({ port, launch, app, expectedSha256 }, limit),
          limit,
          "Listener recheck",
        ),
        report.listener,
      );
    };
    await verifyListener();
    report.socket_path = socketPath;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${socketPath}`);
    browser = new LinuxInspectorProtocol(socket, report);
    await bounded(
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      }),
      deadline,
      "Inspector connection",
    );
    while (!browser.target) {
      if (browser.failure) throw browser.failure;
      assert.ok(Date.now() < deadline, "Main target deadline");
      await pause(20);
    }
    await browser.wait(
      async () => {
        report.document = await browser.executeScript(() => ({
          url: location.href,
          label: window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label,
          webdriver: navigator.webdriver,
          user_agent: navigator.userAgent,
        }));
        return isInspectorMainDocument(report.document);
      },
      Math.max(1, deadline - Date.now()),
    );
    assert.ok(isInspectorMainDocument(report.document));
    await verifyListener();
    report.page_target = browser.target;
    browser.verifyOwnedListener = async () => {
      await verifyListener();
      const finalEvidence = `${evidence}.final.json`;
      await writeFile(
        finalEvidence,
        JSON.stringify(
          {
            ...report,
            frames: browser.frames,
            final_listener_verified_at: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      return finalEvidence;
    };
    browser.observedRuntime = { transport: report.transport, ...report.document };
    browser.ownedProcessIdentity = report.listener;
    report.outcome = "connected-nonautomation-main";
  } catch (error) {
    originalFailure = error;
    report.outcome = "failed";
    report.error = error.message;
    if (browser)
      await browser.quit().catch((secondary) => {
        report.close_error = secondary.message;
      });
  }
  try {
    await writeFile(evidence, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (browser) await browser.quit().catch(() => {});
    if (originalFailure) {
      originalFailure.evidenceFailure = error.message;
      console.error(`Inspector evidence failure (secondary): ${error.message}`);
    } else originalFailure = error;
  }
  if (originalFailure) throw originalFailure;
  return browser;
}
