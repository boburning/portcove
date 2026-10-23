import assert from "node:assert/strict";
import { request } from "node:http";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
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

function rawTransport(t: TestContext) {
  const requests: unknown[] = [];
  const errors: Error[] = [];
  const agent = privateNativeDriverAgent(async (request) => {
    requests.push(request);
    return { status: 200, body_base64: "" };
  }, performance.now() + 5000);
  const stream = agent.createConnection({});
  t.after(() => {
    stream?.destroy();
    agent.destroy();
  });
  assert.ok(stream, "the private agent supplies its owned Duplex synchronously");
  const output: Buffer[] = [];
  stream.on("error", (error: Error) => errors.push(error));
  stream.on("data", (data: Buffer) => output.push(data));
  return {
    agent,
    stream,
    requests,
    errors,
    write: (data: Buffer | string) =>
      new Promise<void>((resolve, reject) => {
        stream.write(data, (error) => (error ? reject(error) : resolve()));
      }),
    response: () =>
      new Promise<Buffer>((resolve, reject) => {
        stream.once("end", () => resolve(Buffer.concat(output)));
        stream.once("error", reject);
        stream.once("close", () => {
          if (!stream.readableEnded) reject(new Error("private response closed before end"));
        });
      }),
  };
}

void test(
  "raw private frames acknowledge incomplete headers and bodies before exactly one exchange",
  { timeout: 5000 },
  async (t) => {
    const transport = rawTransport(t);
    const response = transport.response();
    for (const fragment of ["POST /session HTTP/1.1\r\nContent-Len", "gth: 2\r\n\r", "\n{", ""]) {
      await transport.write(fragment);
      assert.equal(transport.requests.length, 0);
      assert.equal(privateNativeDriverAgentState(transport.agent).requests, 0);
      assert.equal(privateNativeDriverAgentState(transport.agent).refused, false);
    }
    await transport.write("}");
    assert.match((await response).toString(), /^HTTP\/1\.1 200 /u);
    assert.deepEqual(transport.requests, [
      { method: "POST", path: "/session", body_base64: "e30=" },
    ]);
    assert.equal(privateNativeDriverAgentState(transport.agent).requests, 1);
    assert.deepEqual(transport.errors, []);
  },
);

void test(
  "raw private framing refuses malformed complete input before any exchange",
  { timeout: 5000 },
  async (t) => {
    const cases: [string, string, RegExp][] = [
      ["method", "PATCH /status HTTP/1.1\r\n\r\n", /request line differs/u],
      ["version", "GET /status HTTP/1.0\r\n\r\n", /request line differs/u],
      [
        "duplicate mixed-case length",
        "GET /status HTTP/1.1\r\nContent-Length: 0\r\ncOnTeNt-LeNgTh: 0\r\n\r\n",
        /headers are ambiguous/u,
      ],
      [
        "invalid header name",
        "GET /status HTTP/1.1\r\nBad Name: x\r\n\r\n",
        /headers are ambiguous/u,
      ],
      [
        "transfer encoding",
        "GET /status HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
        /streaming\/upgrade/u,
      ],
      ["upgrade", "GET /status HTTP/1.1\r\nUpgrade: websocket\r\n\r\n", /streaming\/upgrade/u],
      ["trailing bytes", "GET /status HTTP/1.1\r\n\r\nx", /trailing bytes/u],
      ["semantic route", "GET /session/../../private HTTP/1.1\r\n\r\n", /route/u],
      ["read-only body", "GET /status HTTP/1.1\r\nContent-Length: 1\r\n\r\nx", /body/u],
      ...["00", "+1", "-1", "1e2", "2097153", "10000000"].map(
        (length): [string, string, RegExp] => [
          `invalid length ${length}`,
          `POST /session HTTP/1.1\r\nContent-Length: ${length}\r\n\r\n`,
          /content length differs/u,
        ],
      ),
    ];
    for (const [name, frame, reason] of cases)
      await t.test(name, async (t) => {
        const transport = rawTransport(t);
        const failure = new Promise<Error>((resolve) => transport.stream.once("error", resolve));
        await assert.rejects(transport.write(frame), reason);
        assert.match((await failure).message, reason);
        assert.deepEqual(transport.requests, []);
        assert.equal(privateNativeDriverAgentState(transport.agent).refused, true);
        assert.throws(() => transport.agent.createConnection({}), /attempt is refused/u);
      });
  },
);

void test(
  "raw private framing keeps exact header/body limits and defers semantic validation until completion",
  { timeout: 5000 },
  async (t) => {
    await t.test("header separator at 16 KiB is accepted", async (t) => {
      const transport = rawTransport(t),
        response = transport.response();
      const prefix = "GET /status HTTP/1.1\r\nX-Pad: ";
      await transport.write(prefix + "a".repeat(16384 - prefix.length) + "\r\n\r\n");
      await response;
      assert.equal(transport.requests.length, 1);
    });
    await t.test("an incomplete header at the limit waits but its next byte refuses", async (t) => {
      const transport = rawTransport(t);
      await transport.write("a".repeat(16384));
      assert.deepEqual(transport.requests, []);
      assert.equal(privateNativeDriverAgentState(transport.agent).refused, false);
      const failure = new Promise<Error>((resolve) => transport.stream.once("error", resolve));
      await assert.rejects(transport.write("a"), /headers exceed bound/u);
      assert.match((await failure).message, /headers exceed bound/u);
      assert.equal(privateNativeDriverAgentState(transport.agent).refused, true);
    });
    await t.test("a complete header beyond the limit refuses", async (t) => {
      const transport = rawTransport(t);
      const failure = new Promise<Error>((resolve) => transport.stream.once("error", resolve));
      await assert.rejects(
        transport.write("a".repeat(16385) + "\r\n\r\n"),
        /headers exceed bound/u,
      );
      await failure;
      assert.deepEqual(transport.requests, []);
    });
    await t.test("body at 2 MiB is accepted without changing bytes", async (t) => {
      const transport = rawTransport(t),
        response = transport.response();
      const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
      await transport.write(`POST /session HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`);
      assert.deepEqual(transport.requests, []);
      await transport.write(body);
      await response;
      assert.deepEqual(transport.requests, [
        { method: "POST", path: "/session", body_base64: body.toString("base64") },
      ]);
    });
    await t.test(
      "semantic-invalid route waits for the declared body before refusing",
      async (t) => {
        const transport = rawTransport(t);
        await transport.write("POST /session?bad HTTP/1.1\r\nContent-Length: 2\r\n\r\nx");
        assert.deepEqual(transport.requests, []);
        assert.equal(privateNativeDriverAgentState(transport.agent).refused, false);
        const failure = new Promise<Error>((resolve) => transport.stream.once("error", resolve));
        await assert.rejects(transport.write("x"), /route/u);
        await failure;
        assert.deepEqual(transport.requests, []);
      },
    );
  },
);

void test(
  "bounded seeded raw frames preserve arbitrary bodies across fragment boundaries",
  { timeout: 5000 },
  async (t) => {
    // Fixed seed, 32 cases, <= 64 body bytes and <= 17 bytes per write.
    let seed = 0x43e61a9d;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (let index = 0; index < 32; index++)
      await t.test(`seed 43e61a9d case ${index}`, async (t) => {
        const body = Buffer.from(Array.from({ length: next() % 65 }, () => next() % 256));
        const noise = next().toString(16);
        const frame = Buffer.concat([
          Buffer.from(
            `POST /session HTTP/1.1\r\nX-Noise: ${noise}\r\nContent-Length: ${body.length}\r\n\r\n`,
          ),
          body,
        ]);
        const transport = rawTransport(t),
          response = transport.response();
        for (let offset = 0; offset < frame.length;) {
          const end = Math.min(frame.length, offset + 1 + (next() % 17));
          await transport.write(frame.subarray(offset, end));
          if (end < frame.length) assert.equal(transport.requests.length, 0);
          offset = end;
        }
        await response;
        assert.deepEqual(transport.requests, [
          { method: "POST", path: "/session", body_base64: body.toString("base64") },
        ]);
        assert.equal(privateNativeDriverAgentState(transport.agent).requests, 1);
        assert.deepEqual(transport.errors, []);
      });
  },
);
