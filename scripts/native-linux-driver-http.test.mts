import assert from "node:assert/strict";
import { request } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import {
  privateNativeDriverAgent,
  inspectPrivateNativeDriverRequest,
  inspectPrivateNativeDriverResponse,
  privateNativeDriverAgentState,
} from "../apps/desktop/scripts/native-linux-driver-http.mts";

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
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
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
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
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

void test(
  "raw private HTTP request fragmentation preserves one bounded exchange",
  { timeout: 5000 },
  async () => {
    const seen: unknown[] = [];
    const agent = privateNativeDriverAgent(async (input) => {
      seen.push(input);
      return { status: 200, body_base64: Buffer.from('{"value":null}').toString("base64") };
    }, performance.now() + 4000);
    const stream = agent.createConnection({ host: "127.0.0.1", port: 9 });
    assert.ok(stream);
    const response = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.once("error", reject);
    });
    const write = (value: string) =>
      new Promise<void>((resolve, reject) => {
        stream.write(Buffer.from(value), (error) => (error ? reject(error) : resolve()));
      });
    try {
      await write("");
      await write("POST /session HTTP/1.1\r\nContent-Length: 7\r\n\r");
      assert.equal(seen.length, 0);
      await write('\n{"x":');
      assert.equal(seen.length, 0);
      await write("1}");
      assert.match(
        await response,
        /Content-Length: 14\r\nConnection: close\r\n\r\n\{"value":null\}$/u,
      );
      assert.deepEqual(seen, [
        {
          method: "POST",
          path: "/session",
          body_base64: Buffer.from('{"x":1}').toString("base64"),
        },
      ]);
      assert.equal(privateNativeDriverAgentState(agent).requests, 1);
      assert.equal(privateNativeDriverAgentState(agent).body_bytes, 21);
      assert.equal(privateNativeDriverAgentState(agent).refused, false);
    } finally {
      stream.destroy();
      agent.destroy();
    }
  },
);

void test(
  "raw private HTTP framing refuses ambiguity and smuggling before any exchange",
  { timeout: 5000 },
  async () => {
    for (const [name, frame, reason] of [
      [
        "duplicate headers",
        "GET /status HTTP/1.1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n",
        /headers are ambiguous/u,
      ],
      [
        "streaming",
        "POST /session HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        /streaming\/upgrade/u,
      ],
      ["upgrade", "GET /status HTTP/1.1\r\nUpgrade: websocket\r\n\r\n", /streaming\/upgrade/u],
      [
        "noncanonical length",
        "POST /session HTTP/1.1\r\nContent-Length: 00\r\n\r\n",
        /content length/u,
      ],
      [
        "oversized body",
        `POST /session HTTP/1.1\r\nContent-Length: ${2 * 1024 * 1024 + 1}\r\n\r\n`,
        /content length/u,
      ],
      ["trailing bytes", "POST /session HTTP/1.1\r\nContent-Length: 0\r\n\r\nx", /trailing bytes/u],
      ["unsupported method", "PATCH /session HTTP/1.1\r\n\r\n", /request line/u],
      ["incomplete oversized header", "a".repeat(16385), /headers exceed bound/u],
      [
        "complete oversized header",
        `GET /status HTTP/1.1\r\nX-Fill: ${"a".repeat(16384)}\r\n\r\n`,
        /headers exceed bound/u,
      ],
    ] as const) {
      let calls = 0;
      const agent = privateNativeDriverAgent(async () => {
        calls++;
        return { status: 200, body_base64: "" };
      }, performance.now() + 4000);
      const stream = agent.createConnection({ host: "127.0.0.1", port: 9 });
      assert.ok(stream);
      const failure = new Promise<Error>((resolve) =>
        stream.once("error", (error: Error) => resolve(error)),
      );
      try {
        stream.write(Buffer.from(frame), () => {});
        assert.match((await failure).message, reason, name);
        assert.equal(calls, 0, name);
        assert.equal(privateNativeDriverAgentState(agent).refused, true, name);
        assert.throws(
          () => agent.createConnection({ host: "127.0.0.1", port: 9 }),
          /attempt is refused/u,
          name,
        );
      } finally {
        stream.destroy();
        agent.destroy();
      }
    }
  },
);
