import { isRecord } from "../../../scripts/runtime-values.mts";
function parseJson(value: string): unknown {
  return JSON.parse(value);
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function required<Value>(value: Value | undefined): Value {
  assert.ok(value !== undefined);
  return value;
}
interface InspectorRequest {
  id: number;
  method: string;
  params: { targetId: string; message: string };
}
function nestedRequest(value: string) {
  const request = object(JSON.parse(value));
  assert.ok(typeof request.id === "number" && typeof request.method === "string");
  return { ...request, id: request.id, method: request.method, params: object(request.params) };
}
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertLocalMainUrl, chromeObserverEndpoint } from "./desktop-main-webview-boundary.mts";
import {
  inspectorSocketPath,
  mappedWebKitLibraries,
  isInspectorMainDocument,
  linuxInspectorEnvironment,
  LinuxInspectorProtocol,
} from "./desktop-linux-webkit-inspector.mts";

// Imported by the maintained desktop-scenarios contract suite. Keep native-only
// helper consumers adjacent so the frontend graph observes their actual tests.
void test("native boundary contracts import before desktop dependencies are installed", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-boundary-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const desktop = path.join(directory, "apps/desktop/scripts");
  const scripts = path.join(directory, "scripts");
  await mkdir(desktop, { recursive: true });
  await mkdir(scripts);
  for (const name of ["desktop-main-webview-boundary.mts", "browser-script.mts"])
    await copyFile(new URL(name, import.meta.url), path.join(desktop, name));
  for (const name of ["runtime-values.mts", "development-evidence.mts"])
    await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), path.join(scripts, name));
  const module = pathToFileURL(path.join(desktop, "desktop-main-webview-boundary.mts")).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

void test("external browser observation uses only the owned Chrome loopback endpoint", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(
    chromeObserverEndpoint(`45123\n/devtools/browser/${id}\n`),
    `ws://127.0.0.1:45123/devtools/browser/${id}`,
  );
  for (const input of [
    `0\n/devtools/browser/${id}`,
    `65536\n/devtools/browser/${id}`,
    `45123\nws://external.invalid/devtools/browser/${id}`,
    `45123\n/devtools/page/${id}`,
    `45123\n/devtools/browser/${id}\n\nignored-extra`,
  ])
    assert.throws(() => chromeObserverEndpoint(input));
});

void test("local native boundary identity does not treat opaque URL origins as equal", () => {
  assertLocalMainUrl("tauri://localhost", "linux");
  assertLocalMainUrl("tauri://localhost/", "linux");
  assertLocalMainUrl("http://tauri.localhost/", "win32");
  for (const url of [
    "tauri://untrusted/",
    "file:///tmp/index.html",
    "http://tauri.localhost/",
    "tauri://user@localhost/",
    "tauri://localhost:8443/",
  ])
    assert.throws(() => assertLocalMainUrl(url, "linux"), url);
  for (const url of [
    "https://tauri.localhost/",
    "tauri://localhost/",
    "http://tauri.localhost:8443/",
  ])
    assert.throws(() => assertLocalMainUrl(url, "win32"), url);
  assert.throws(() => assertLocalMainUrl("tauri://localhost/", "darwin"));
});

class InspectorSocket extends EventTarget {
  sent: InspectorRequest[] = [];
  closed = false;
  send(message: string) {
    const request = object(JSON.parse(message));
    const params = object(request.params);
    assert.ok(typeof request.id === "number");
    this.sent.push({
      ...request,
      id: request.id,
      method: text(request.method),
      params: { ...params, targetId: text(params.targetId), message: text(params.message) },
    });
  }
  close() {
    this.closed = true;
  }
  emit(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  reply(request: InspectorRequest, result: unknown, target = "page-1") {
    this.emit({
      method: "Target.dispatchMessageFromTarget",
      params: {
        targetId: target,
        message: JSON.stringify({ id: nestedRequest(request.params.message).id, result }),
      },
    });
  }
}

function inspector() {
  const socket = new InspectorSocket();
  const protocol = new LinuxInspectorProtocol(socket, {});
  socket.emit({
    method: "Target.targetCreated",
    params: {
      targetInfo: { targetId: "page-1", type: "page", isProvisional: false },
    },
  });
  return { socket, protocol };
}

async function waitForRequest(socket: InspectorSocket, count: number) {
  const end = Date.now() + 1000;
  while (socket.sent.length < count) {
    assert.ok(Date.now() < end, "Protocol control did not reach its next command");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return required(socket.sent[count - 1]);
}

void test("Linux inspector environment removes automation without overriding permissions", () => {
  const original = {
    TAURI_WEBVIEW_AUTOMATION: "true",
    WEBKIT_INSPECTOR_SERVER: "remote:1",
    KEEP: "value",
  };
  assert.deepEqual(linuxInspectorEnvironment(original, 45123), {
    KEEP: "value",
    WEBKIT_INSPECTOR_HTTP_SERVER: "127.0.0.1:45123",
  });
  assert.equal(original.TAURI_WEBVIEW_AUTOMATION, "true");
  for (const port of [0, 65536, "45123", NaN])
    assert.throws(() => linuxInspectorEnvironment({}, port));
});

void test("inspector discovery selects one canonical tuple rather than executing HTML", () => {
  assert.equal(inspectorSocketPath("window.open('/socket/2/3/WebPage')"), "/socket/2/3/WebPage");
  for (const html of [
    "",
    "/socket/0/3/WebPage",
    "/socket/02/3/WebPage",
    "/socket/2/3/Automation",
    "/socket/2/3/WebPage /socket/4/5/WebPage",
    "/socket/2/99999999999999999999/WebPage",
    "x".repeat(65537),
  ])
    assert.throws(() => inspectorSocketPath(html));
});

void test("loaded-engine evidence distinguishes mapped AppImage libraries from host package versions", () => {
  const file = "/tmp/.mount_Portcove/usr/lib/libwebkit2gtk-4.1.so.0.22.6";
  const row = (name: string) => `7f00-7fff r-xp 00000000 08:01 123 ${name}`;
  assert.deepEqual(
    mappedWebKitLibraries([row(file), row(file), row("/usr/lib/unrelated.so.1")].join("\n")),
    [file],
  );
  assert.throws(() => mappedWebKitLibraries(row("/usr/lib/unrelated.so.1")));
  assert.throws(() => mappedWebKitLibraries(row(`${file} (deleted)`)));
  assert.throws(() => mappedWebKitLibraries("x".repeat(4 * 1024 * 1024 + 1)));
});

void test("inspector readiness accepts both observed local spellings and requires the nonautomation main view", () => {
  for (const url of ["tauri://localhost", "tauri://localhost/"])
    assert.equal(isInspectorMainDocument({ url, label: "main", webdriver: false }), true);
  for (const url of [
    "tauri://untrusted/",
    "tauri://user@localhost/",
    "tauri://localhost:8443/",
    "tauri://localhost/other",
    "tauri://localhost/?query",
    "http://tauri.localhost/",
    "file:///tmp/index.html",
  ])
    assert.equal(isInspectorMainDocument({ url, label: "main", webdriver: false }), false);
  for (const document of [
    { url: "tauri://localhost", label: "secondary", webdriver: false },
    { url: "tauri://localhost", label: "main", webdriver: true },
    { url: "tauri://localhost", label: "main" },
  ])
    assert.equal(isInspectorMainDocument(document), false);
});

void test("inspector refuses thrown scripts, rejected callbacks and non-Promise handles", async () => {
  for (const failure of ["evaluate-threw", "await-rejected", "not-promise"]) {
    const { socket, protocol } = inspector();
    const execution = protocol.executeScript(() => "must not be accepted as a refusal");
    if (failure === "evaluate-threw") {
      socket.reply(required(socket.sent[0]), {
        wasThrown: true,
        result: { type: "object", description: "script failure" },
      });
    } else {
      socket.reply(required(socket.sent[0]), {
        result: {
          type: "object",
          className: failure === "not-promise" ? "Object" : "Promise",
          objectId: "result-handle",
        },
      });
      if (failure === "await-rejected") {
        const request = await waitForRequest(socket, 2);
        socket.reply(request, {
          wasThrown: true,
          result: { type: "object", description: "callback rejection" },
        });
      }
    }
    await assert.rejects(execution, /threw|rejected|Promise/);
    assert.equal(socket.sent.length, failure === "await-rejected" ? 2 : 1);
    await protocol.quit();
  }
});

void test("inspector executes real serialized sync and callback scripts through promise results", async () => {
  for (const callback of [false, true]) {
    const { socket, protocol } = inspector();
    const promise = callback
      ? protocol.executeAsyncScript((value, done) => queueMicrotask(() => done({ value })), "owned")
      : protocol.executeScript((value) => ({ value }), "owned");
    const evaluate = nestedRequest(required(socket.sent[0]).params.message);
    assert.equal(evaluate.method, "Runtime.evaluate");
    const actual: unknown = vm.runInNewContext(text(evaluate.params.expression), {
      queueMicrotask,
    });
    socket.reply(required(socket.sent[0]), {
      result: { type: "object", className: "Promise", objectId: "owned-promise" },
    });
    const awaitRequest = await waitForRequest(socket, 2);
    const command = nestedRequest(awaitRequest.params.message);
    assert.equal(command.method, "Runtime.awaitPromise");
    assert.equal(command.params.promiseObjectId, "owned-promise");
    socket.reply(awaitRequest, {
      result: { type: "object", value: parseJson(JSON.stringify(await actual)) },
    });
    assert.deepEqual(await promise, { value: "owned" });
    await protocol.quit();
  }
});

void test("inspector propagates wrong-target and native protocol errors", async () => {
  const { socket, protocol } = inspector();
  const request = protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
  socket.reply(
    required(socket.sent[0]),
    { result: { type: "string", value: "untrusted" } },
    "other-page",
  );
  await assert.rejects(request, /main target/);
  await assert.rejects(protocol.command("Runtime.evaluate", {}, Date.now() + 1000), /main target/);
  const next = inspector();
  const refused = next.protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
  next.socket.emit({ id: required(next.socket.sent[0]).id, error: { message: "native refusal" } });
  await assert.rejects(refused, /native refusal/);
  await next.protocol.quit();
});

void test("expired inspector operation cannot accept a late callback as a later success", async () => {
  const { socket, protocol } = inspector();
  const first = protocol.command("Runtime.awaitPromise", {}, Date.now() + 10);
  const oldRequest = required(socket.sent[0]);
  await assert.rejects(first, /deadline/);
  const next = protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
  socket.reply(oldRequest, { result: { type: "string", value: "late" } });
  socket.reply(required(socket.sent[1]), { result: { type: "string", value: "current" } });
  assert.deepEqual(await next, { result: { type: "string", value: "current" } });
  assert.equal(protocol.pending.size, 0);
  await protocol.quit();
});

void test("inspector location reads preserve the strict script budget and reject unsupported controls", async () => {
  const { socket, protocol } = inspector();
  await protocol.manage().setTimeouts({ script: 10000, pageLoad: 10000 });
  await assert.rejects(protocol.manage().setTimeouts({ script: 10001 }));
  await assert.rejects(protocol.manage().setTimeouts({ implicit: 10000 }));
  const current = protocol.getCurrentUrl();
  const evaluate = nestedRequest(required(socket.sent[0]).params.message);
  const actual: unknown = vm.runInNewContext(text(evaluate.params.expression), {
    location: { href: "tauri://localhost/" },
  });
  socket.reply(required(socket.sent[0]), {
    result: { type: "object", className: "Promise", objectId: "location-result" },
  });
  const awaitRequest = await waitForRequest(socket, 2);
  socket.reply(awaitRequest, { result: { type: "string", value: await actual } });
  assert.equal(await current, "tauri://localhost/");
  await protocol.quit();
});

void test("inspector screenshot observes the viewport and refuses a non-PNG response", async () => {
  const { socket, protocol } = inspector();
  const capture = protocol.takeScreenshot();
  socket.reply(required(socket.sent[0]), {
    result: { type: "object", className: "Promise", objectId: "viewport-result" },
  });
  const viewportRequest = await waitForRequest(socket, 2);
  socket.reply(viewportRequest, {
    result: { type: "object", value: { width: 1280, height: 800 } },
  });
  const snapshot = await waitForRequest(socket, 3);
  assert.deepEqual(nestedRequest(snapshot.params.message), {
    id: nestedRequest(snapshot.params.message).id,
    method: "Page.snapshotRect",
    params: { x: 0, y: 0, width: 1280, height: 800, coordinateSystem: "Viewport" },
  });
  socket.reply(snapshot, { dataURL: "data:image/jpeg;base64,invalid" });
  await assert.rejects(capture, /png/);
  await protocol.quit();
});

void test("inspector rejects malformed native envelopes without admitting later replies", async () => {
  for (const message of [
    null,
    [],
    "untrusted",
    {
      method: "Target.targetCreated",
      params: { targetInfo: { type: "page", isProvisional: false, targetId: 42 } },
    },
    { method: "Target.dispatchMessageFromTarget", params: { targetId: "page-1", message: [] } },
    { method: "Target.dispatchMessageFromTarget", params: { targetId: "page-1", message: "null" } },
  ]) {
    const { socket, protocol } = inspector();
    const pending = protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
    socket.emit(message);
    await assert.rejects(pending);
    assert.ok(protocol.failure);
    const failure = protocol.failure;
    await assert.rejects(
      protocol.command("Runtime.evaluate", {}, Date.now() + 1000),
      (error) => error === failure,
    );
    assert.equal(protocol.pending.size, 0);
    assert.equal(protocol.outer.size, 0);
    await protocol.quit();
  }
});
void test("erased inspector callback control never coerces a string reply ID into authority", async () => {
  const { socket, protocol } = inspector();
  const pending = protocol.command("Runtime.evaluate", {}, Date.now() + 20);
  const request = nestedRequest(required(socket.sent[0]).params.message);
  socket.emit({
    method: "Target.dispatchMessageFromTarget",
    params: {
      targetId: "page-1",
      message: JSON.stringify({ id: String(request.id), result: { value: "untrusted" } }),
    },
  });
  await assert.rejects(pending, /deadline/);
  assert.equal(protocol.pending.size, 0);
  assert.equal(protocol.outer.size, 0);
  await protocol.quit();
});

void test("inspector retains every primitive failure and refuses subsequent commands", async () => {
  for (const failure of [false, 0, "", null, undefined]) {
    const { socket, protocol } = inspector();
    protocol.fail(failure);
    const count = socket.sent.length;
    await assert.rejects(protocol.command("Runtime.evaluate", {}, Date.now() + 10), (error) =>
      Object.is(error, failure),
    );
    assert.equal(socket.sent.length, count, "Failed observers must not send another operation");
    await protocol.quit();
    assert.ok(
      Object.is(protocol.failure, failure),
      "Close must preserve the first failure identity",
    );
  }
});

void test("inspector connection preserves primitive primary failures through evidence failures", () => {
  for (const variant of ["original", "aliased", "wrong-export"] as const) {
    const execute = () =>
      runDesktopModuleFixture(
        new URL("./desktop-linux-webkit-inspector.mts", import.meta.url),
        `
      // Synthetic Linux metadata in this disposable child is not native evidence.
      Object.defineProperty(process, 'platform', {value:'linux'});
      globalThis.fetch=forbidden;
      globalThis.WebSocket=class {constructor(){forbidden();}};
      const fileSystem=await import('node:fs/promises');
      let reports=[],logs=[],evidenceFails=false;
      const secondary=new Error('owned report write failure');
      mock.module('node:fs/promises',{namedExports:{...Object.fromEntries(
        Object.entries(fileSystem).filter(([name])=>name!=='default').map(([name,value])=>
          [name,typeof value==='function'?forbidden:value])),
        writeFile:async(file,bytes,options)=>{
          assert.equal(file,'owned-report.json');
          assert.deepEqual(options,{flag:'wx'});
          reports.push(JSON.parse(bytes));
          if(evidenceFails)throw secondary;
        },
      }});
      console.error=message=>logs.push(message);
      const {connectLinuxInspector}=await import(entry);
      for(const failure of [false,0,'',null,undefined]){
        for(evidenceFails of [false,true]){
          reports=[];logs=[];let callbacks=0;
          const invocation=connectLinuxInspector({port:45123,
            launch:{child:{pid:123,exitCode:null}},app:'/owned-fixture',
            expectedSha256:'a'.repeat(64),evidence:'owned-report.json',
            beforeConnect:async()=>{callbacks++;throw failure;}});
          await assert.rejects(invocation,error=>Object.is(error,failure),
            'INSPECTOR_PRIMARY_IDENTITY must retain the consumed entrypoint rejection');
          assert.equal(callbacks,1);
          assert.equal(reports.length,1);
          assert.equal(reports[0].outcome,'failed');
          assert.equal(reports[0].automation,false);
          assert.deepEqual(reports[0].discovery,[]);
          assert.equal(logs.length,evidenceFails?1:0);
          if(evidenceFails)assert.ok(logs[0].includes(secondary.message), "Secondary evidence failure must be reported");
        }
      }
      console.log('primitive primary/evidence failures PASS; synthetic platform, no native acceptance');
      `,
        variant === "original" ? undefined : { exportName: "connectLinuxInspector", variant },
      );
    if (variant === "wrong-export") assert.throws(execute, /INSPECTOR_PRIMARY_IDENTITY/u);
    else assert.match(execute(), /primitive primary\/evidence failures PASS/u);
  }
});
