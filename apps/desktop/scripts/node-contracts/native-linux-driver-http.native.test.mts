import assert from "node:assert/strict";
import { request } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import {
  privateNativeDriverAgent,
  inspectPrivateNativeDriverRequest,
  inspectPrivateNativeDriverResponse,
  privateNativeDriverAgentState,
} from "../native-linux-driver-http.mts";

void test("WebDriver commands traverse the private exchange without opening the requested TCP endpoint", async () => {
  const seen: unknown[] = [];
  const expected = JSON.stringify({ value: { sessionId: "inert", capabilities: {} } });
  const agent = privateNativeDriverAgent(async (input) => {
    seen.push(input);
    return { status: 200, body_base64: Buffer.from(expected).toString("base64") };
  }, performance.now() + 5000);
  try {
    const body = JSON.stringify({ capabilities: { alwaysMatch: { browserName: "wry" } } });
    const response = await new Promise<string>((resolve, reject) => {
      const child = request(
        "http://127.0.0.1:9/session",
        {
          agent,
          method: "POST",
          headers: {
            "content-length": Buffer.byteLength(body),
            "content-type": "application/json",
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          incoming.on("error", reject);
        },
      );
      child.on("error", reject);
      child.end(body);
    });
    assert.equal(response, expected);
    assert.deepEqual(seen, [
      { method: "POST", path: "/session", body_base64: Buffer.from(body).toString("base64") },
    ]);
  } finally {
    agent.destroy();
  }
});

void test("canonical full-size private bodies stay bounded without regex backtracking", () => {
  const body_base64 = Buffer.alloc(2 * 1024 * 1024, 0x61).toString("base64");
  assert.equal(
    inspectPrivateNativeDriverRequest({ method: "POST", path: "/session", body_base64 })
      .body_base64,
    body_base64,
  );
  assert.throws(() =>
    inspectPrivateNativeDriverRequest({
      method: "POST",
      path: "/session",
      body_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
    }),
  );
});

void test("the installed Selenium transport cannot automatically retry an ambiguous private channel failure", async () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const { HttpClient, Request } = require("selenium-webdriver/http") as {
    HttpClient: new (
      url: string,
      agent: ReturnType<typeof privateNativeDriverAgent>,
    ) => { send(input: unknown): Promise<unknown> };
    Request: new (method: string, path: string, data?: unknown) => unknown;
  };
  let calls = 0;
  const agent = privateNativeDriverAgent(async () => {
    calls++;
    throw Object.assign(new Error("inert original channel refusal"), { code: "ECONNRESET" });
  }, performance.now() + 5000);
  try {
    await assert.rejects(
      new HttpClient("http://127.0.0.1:9", agent).send(
        new Request("POST", "/session", { capabilities: {} }),
      ),
      /private native driver exchange refused/,
    );
    assert.equal(calls, 1);
    assert.equal(privateNativeDriverAgentState(agent).refused, true);
    await assert.rejects(
      new HttpClient("http://127.0.0.1:9", agent).send(new Request("GET", "/status")),
      /attempt is refused/,
    );
    assert.equal(calls, 1);
  } finally {
    agent.destroy();
  }
});

void test("installed Selenium performs the required status/session/delete operations through only the private exchange", async () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const { HttpClient, Request } = require("selenium-webdriver/http") as {
    HttpClient: new (
      url: string,
      agent: ReturnType<typeof privateNativeDriverAgent>,
    ) => { send(input: unknown): Promise<{ status: number; body: string }> };
    Request: new (method: string, path: string, data?: unknown) => unknown;
  };
  const seen: unknown[] = [];
  const agent = privateNativeDriverAgent(async (input) => {
    seen.push(input);
    return { status: 200, body_base64: Buffer.from('{"value":null}').toString("base64") };
  }, performance.now() + 5000);
  try {
    const client = new HttpClient("http://127.0.0.1:9", agent);
    for (const [method, route, data] of [
      ["GET", "/status", null],
      ["POST", "/session", { capabilities: {} }],
      ["DELETE", "/session/inert", null],
    ] as const) {
      const response = await client.send(new Request(method, route, data));
      assert.equal(response.status, 200);
      assert.equal(response.body, '{"value":null}');
    }
    assert.deepEqual(seen, [
      { method: "GET", path: "/status", body_base64: "" },
      {
        method: "POST",
        path: "/session",
        body_base64: Buffer.from('{"capabilities":{}}').toString("base64"),
      },
      { method: "DELETE", path: "/session/inert", body_base64: "" },
    ]);
  } finally {
    agent.destroy();
  }
});

void test("private driver refuses arbitrary routes, methods, bodies and response smuggling", () => {
  const valid = { method: "GET", path: "/status", body_base64: "" };
  assert.deepEqual(inspectPrivateNativeDriverRequest(valid), valid);
  assert.deepEqual(
    inspectPrivateNativeDriverRequest({ ...valid, path: "/native-public-runtime" }),
    { ...valid, path: "/native-public-runtime" },
  );
  for (const changed of [
    { ...valid, method: "CONNECT" },
    { ...valid, path: "http://127.0.0.1:80/" },
    { ...valid, path: "/session/../../private" },
    { ...valid, path: "/session/%2e%2e/private" },
    { ...valid, path: "/session?url=http://host" },
    { ...valid, body_base64: "YQ==" },
    { ...valid, body_base64: "YWJj\n" },
    { ...valid, accepted: true },
    { ...valid, path: "/native-public-runtime", method: "POST" },
    { ...valid, path: "/native-public-runtime", method: "DELETE" },
    { ...valid, path: "/native-public-runtime", body_base64: "YQ==" },
  ])
    assert.throws(() => inspectPrivateNativeDriverRequest(changed));
  for (const changed of [
    { status: 101, body_base64: "" },
    { status: 200, body_base64: "=bad" },
    { status: 200, body_base64: "", headers: { location: "http://host" } },
  ])
    assert.throws(() => inspectPrivateNativeDriverResponse(changed));
});

void test("an expired private driver budget performs zero exchanges and cannot fall back to TCP", async () => {
  let calls = 0;
  const agent = privateNativeDriverAgent(async () => {
    calls++;
    return { status: 200, body_base64: "" };
  }, performance.now() - 1);
  try {
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const child = request("http://127.0.0.1:9/status", { agent }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        child.on("error", reject);
        child.end();
      }),
      /lifetime/,
    );
    assert.equal(calls, 0);
  } finally {
    agent.destroy();
  }
});

void test("cancelling an in-flight owned exchange latches refusal until the whole native attempt is reconciled", async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const agent = privateNativeDriverAgent(async () => {
    started();
    return pending;
  }, performance.now() + 5000);
  const child = request("http://127.0.0.1:9/status", { agent });
  const failed = new Promise<void>((resolve) => child.once("error", () => resolve()));
  child.end();
  try {
    await beginning;
    child.destroy(new Error("inert client cancellation"));
    await failed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(privateNativeDriverAgentState(agent).refused, true);
    assert.equal(privateNativeDriverAgentState(agent).requests, 1);
  } finally {
    release({ status: 200, body_base64: "" });
    agent.destroy();
  }
});
