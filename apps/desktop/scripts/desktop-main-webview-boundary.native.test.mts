import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { assertLocalMainUrl, chromeObserverEndpoint } from "./desktop-main-webview-boundary.mts";
import {
  inspectorSocketPath,
  isInspectorMainDocument,
  linuxInspectorEnvironment,
  LinuxInspectorProtocol,
} from "./desktop-linux-webkit-inspector.mts";

// Imported by the maintained desktop-scenarios contract suite. Keep native-only
// helper consumers adjacent so the frontend graph observes their actual tests.
test("external browser observation uses only the owned Chrome loopback endpoint", () => {
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

test("local native boundary identity does not treat opaque URL origins as equal", () => {
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
  sent = [];
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  close() {
    this.closed = true;
  }
  emit(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  reply(request, result, target = "page-1") {
    this.emit({
      method: "Target.dispatchMessageFromTarget",
      params: {
        targetId: target,
        message: JSON.stringify({ id: JSON.parse(request.params.message).id, result }),
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

async function waitForRequest(socket, count) {
  const end = Date.now() + 1000;
  while (socket.sent.length < count) {
    assert.ok(Date.now() < end, "Protocol control did not reach its next command");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return socket.sent[count - 1];
}

test("Linux inspector environment removes automation without overriding permissions", () => {
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

test("inspector discovery selects one canonical tuple rather than executing HTML", () => {
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

test("inspector readiness accepts both observed local spellings and requires the nonautomation main view", () => {
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

test("inspector refuses thrown scripts, rejected callbacks and non-Promise handles", async () => {
  for (const failure of ["evaluate-threw", "await-rejected", "not-promise"]) {
    const { socket, protocol } = inspector();
    const execution = protocol.executeScript(() => "must not be accepted as a refusal");
    if (failure === "evaluate-threw") {
      socket.reply(socket.sent[0], {
        wasThrown: true,
        result: { type: "object", description: "script failure" },
      });
    } else {
      socket.reply(socket.sent[0], {
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

test("inspector executes real serialized sync and callback scripts through promise results", async () => {
  for (const callback of [false, true]) {
    const { socket, protocol } = inspector();
    const promise = callback
      ? protocol.executeAsyncScript((value, done) => queueMicrotask(() => done({ value })), "owned")
      : protocol.executeScript((value) => ({ value }), "owned");
    const evaluate = JSON.parse(socket.sent[0].params.message);
    assert.equal(evaluate.method, "Runtime.evaluate");
    const actual = vm.runInNewContext(evaluate.params.expression, { queueMicrotask });
    socket.reply(socket.sent[0], {
      result: { type: "object", className: "Promise", objectId: "owned-promise" },
    });
    const awaitRequest = await waitForRequest(socket, 2);
    const command = JSON.parse(awaitRequest.params.message);
    assert.equal(command.method, "Runtime.awaitPromise");
    assert.equal(command.params.promiseObjectId, "owned-promise");
    socket.reply(awaitRequest, {
      result: { type: "object", value: JSON.parse(JSON.stringify(await actual)) },
    });
    assert.deepEqual(await promise, { value: "owned" });
    await protocol.quit();
  }
});

test("inspector propagates wrong-target and native protocol errors", async () => {
  const { socket, protocol } = inspector();
  const request = protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
  socket.reply(socket.sent[0], { result: { type: "string", value: "untrusted" } }, "other-page");
  await assert.rejects(request, /main target/);
  await assert.rejects(protocol.command("Runtime.evaluate", {}, Date.now() + 1000), /main target/);
  const next = inspector();
  const refused = next.protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
  next.socket.emit({ id: next.socket.sent[0].id, error: { message: "native refusal" } });
  await assert.rejects(refused, /native refusal/);
  await next.protocol.quit();
});

test("expired inspector operation cannot accept a late callback as a later success", async () => {
  const { socket, protocol } = inspector();
  const first = protocol.command("Runtime.awaitPromise", {}, Date.now() + 10);
  const oldRequest = socket.sent[0];
  await assert.rejects(first, /deadline/);
  const next = protocol.command("Runtime.evaluate", {}, Date.now() + 1000);
  socket.reply(oldRequest, { result: { type: "string", value: "late" } });
  socket.reply(socket.sent[1], { result: { type: "string", value: "current" } });
  assert.deepEqual(await next, { result: { type: "string", value: "current" } });
  assert.equal(protocol.pending.size, 0);
  await protocol.quit();
});

test("inspector location reads preserve the strict script budget and reject unsupported controls", async () => {
  const { socket, protocol } = inspector();
  await protocol.manage().setTimeouts({ script: 10000, pageLoad: 10000 });
  await assert.rejects(protocol.manage().setTimeouts({ script: 10001 }));
  await assert.rejects(protocol.manage().setTimeouts({ implicit: 10000 }));
  const current = protocol.getCurrentUrl();
  const evaluate = JSON.parse(socket.sent[0].params.message);
  const actual = vm.runInNewContext(evaluate.params.expression, {
    location: { href: "tauri://localhost/" },
  });
  socket.reply(socket.sent[0], {
    result: { type: "object", className: "Promise", objectId: "location-result" },
  });
  const awaitRequest = await waitForRequest(socket, 2);
  socket.reply(awaitRequest, { result: { type: "string", value: await actual } });
  assert.equal(await current, "tauri://localhost/");
  await protocol.quit();
});

test("inspector screenshot observes the viewport and refuses a non-PNG response", async () => {
  const { socket, protocol } = inspector();
  const capture = protocol.takeScreenshot();
  socket.reply(socket.sent[0], {
    result: { type: "object", className: "Promise", objectId: "viewport-result" },
  });
  const viewportRequest = await waitForRequest(socket, 2);
  socket.reply(viewportRequest, {
    result: { type: "object", value: { width: 1280, height: 800 } },
  });
  const snapshot = await waitForRequest(socket, 3);
  assert.deepEqual(JSON.parse(snapshot.params.message), {
    id: JSON.parse(snapshot.params.message).id,
    method: "Page.snapshotRect",
    params: { x: 0, y: 0, width: 1280, height: 800, coordinateSystem: "Viewport" },
  });
  socket.reply(snapshot, { dataURL: "data:image/jpeg;base64,invalid" });
  await assert.rejects(capture, /png/);
  await protocol.quit();
});
