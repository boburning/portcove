import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Socket } from "node:net";

import { requiredFixture, record, root } from "./fixtures/catalog-generator-fixtures.mts";

const lifecycleIdentity = {
  game_id: 101,
  slug: "probe",
  names: ["Probe"],
  evidence_url: "https://example.org/probe",
};

function lifecycleCredentials() {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-response-lifecycle-"));
  const file = join(scratch, "private-fixture.json");
  writeFileSync(file, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  return file;
}

async function boundedLifecycleResult<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned response cleanup did not settle.")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const spec of [
  { name: "OAuth status", route: "token", status: 403, error: /authentication unavailable/ },
  { name: "OAuth length", route: "token", status: 200, length: 65537, error: /byte contract/ },
  { name: "metadata429", route: "games", status: 429, retry: "1", error: /identity request/ },
  { name: "metadata503", route: "games", status: 503, error: /identity request/ },
  {
    name: "metadata batch refusal",
    route: "games",
    status: 429,
    retry: "900",
    error: /identity request/,
    refusesNext: true,
  },
  { name: "metadata length", route: "games", status: 200, length: 1048577, error: /byte contract/ },
  { name: "image Gone", route: "image", status: 410, error: /image is gone/ },
  { name: "image status", route: "image", status: 503, error: /image unavailable/ },
  {
    name: "image MIME",
    route: "image",
    status: 200,
    mime: "text/plain",
    error: /image unavailable/,
  },
  {
    name: "image length",
    route: "image",
    status: 200,
    length: 4096,
    error: /remaining bounded operation/,
  },
  {
    name: "image streaming limit",
    route: "image",
    status: 200,
    error: /remaining bounded operation/,
  },
  {
    name: "image oversized response",
    route: "image",
    status: 200,
    length: 16777217,
    error: /byte contract/,
  },
]) {
  void test(`provider response lifecycle closes unfinished ${spec.name} before request timeout`, async () => {
    const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
    const sockets = new Set<Socket>();
    let selectedResponse: Response | undefined;
    let closeTransfer = () => {};
    const closed = new Promise<void>((resolve) => {
      closeTransfer = resolve;
    });
    const routes: string[] = [];
    const server = createServer((request, response) => {
      const route = (request.url ?? "").slice(1);
      routes.push(route);
      if (route !== spec.route) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ access_token: "fixture" }));
        return;
      }
      response.on("close", closeTransfer);
      response.writeHead(spec.status, {
        "Content-Type": spec.mime ?? (route === "image" ? "image/jpeg" : "application/json"),
        ...(spec.retry ? { "Retry-After": spec.retry } : {}),
        ...(spec.length ? { "Content-Length": String(spec.length) } : {}),
      });
      response.flushHeaders();
      // The transfer deliberately stays incomplete; cleanup must not drain it.
      response.write(Buffer.alloc(2048, 0x65));
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const origin = `http://127.0.0.1:${String(record(server.address()).port)}`;
      const inspector = createIgdbInspector(
        lifecycleCredentials(),
        () => assert.fail("refused response must not reach the decoder"),
        async (url, options) => {
          assert.equal(options.redirect, "error");
          assert.equal(requiredFixture(options.signal).aborted, false);
          const route =
            url === "https://id.twitch.tv/oauth2/token"
              ? "token"
              : url === "https://api.igdb.com/v4/games"
                ? "games"
                : "image";
          const response = await fetch(`${origin}/${route}`, options);
          if (route === spec.route) selectedResponse = response;
          return response;
        },
      );
      await assert.rejects(
        spec.route === "image"
          ? inspector.inspectImage("coprobe", 1024)
          : inspector.inspectGame(lifecycleIdentity),
        spec.error,
      );
      // Observe cancellation before test-owned socket teardown can supply it.
      await boundedLifecycleResult(closed);
      assert.equal(requiredFixture(requiredFixture(selectedResponse).body).locked, false);
      assert.equal(requiredFixture(selectedResponse).bodyUsed, true);
      if (spec.refusesNext) {
        await assert.rejects(inspector.inspectGame(lifecycleIdentity), /batch deadline reached/);
        assert.deepEqual(routes, ["token", "games"]);
      }
      if (spec.name === "image streaming limit") {
        // Fetch may split the server's write: account for the consumed chunks,
        // stopping as soon as the remaining budget is exceeded.
        assert.ok(inspector.providerMetrics.image_bytes > 1024);
        assert.ok(inspector.providerMetrics.image_bytes <= 2048);
      } else assert.equal(inspector.providerMetrics.image_bytes, 0);
      assert.equal(
        inspector.providerMetrics.authentication_requests,
        spec.route === "image" ? 0 : 1,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

for (const refusal of ["status", "length", "streaming"]) {
  for (const cancellation of ["resolve", "reject", "throw", "pending"]) {
    void test(`provider response lifecycle retains ${refusal} failure with ${cancellation} cancellation`, async () => {
      const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
      let cancellations = 0;
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2));
          },
          cancel() {
            cancellations++;
            if (cancellation === "reject") return Promise.reject(new Error("cleanup failure"));
            if (cancellation === "throw") throw new Error("cleanup failure");
            if (cancellation === "pending") return new Promise(() => {});
          },
        }),
        {
          status: refusal === "status" ? 503 : 200,
          headers: {
            "Content-Type": "image/jpeg",
            ...(refusal === "length" ? { "Content-Length": "2" } : {}),
          },
        },
      );
      const inspector = createIgdbInspector(
        lifecycleCredentials(),
        () => assert.fail("refused response must not reach the decoder"),
        async () => response,
      );
      await assert.rejects(boundedLifecycleResult(inspector.inspectImage("coprobe", 1)), {
        message:
          refusal === "status"
            ? "IGDB image unavailable."
            : "Response exceeds the remaining bounded operation; continue in a fresh batch.",
      });
      assert.equal(cancellations, 1);
      assert.equal(requiredFixture(response.body).locked, false);
      assert.equal(inspector.providerMetrics.image_requests, 1);
      assert.equal(inspector.providerMetrics.image_bytes, refusal === "streaming" ? 2 : 0);
    });
  }
}

void test("provider response lifecycle releases an aborted reader without changing its error", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const primary = new DOMException("fixture request aborted", "AbortError");
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(primary);
      },
    }),
    { headers: { "Content-Type": "image/jpeg" } },
  );
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("aborted response must not decode"),
    async () => response,
  );
  await assert.rejects(inspector.inspectImage("coprobe"), (error) => error === primary);
  assert.equal(requiredFixture(response.body).locked, false);
  assert.equal(inspector.providerMetrics.image_bytes, 0);
});

void test("provider response lifecycle preserves consumed JSON and exact image bytes", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const bytes = readFileSync(join(root, "apps/desktop/scripts/testdata/catalog-artwork-red.jpg"));
  const responses = [
    Response.json({ access_token: "fixture" }),
    Response.json([]),
    new Response(bytes, { headers: { "Content-Type": "image/jpeg" } }),
  ];
  let requests = 0;
  let decodes = 0;
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    (value) => {
      decodes++;
      assert.deepEqual(value, bytes);
      return { width: 12, height: 24, format: "jpeg", validator: "portcove-core" };
    },
    async () => requiredFixture(responses[requests++]),
  );
  assert.deepEqual(await inspector.inspectGame(lifecycleIdentity), []);
  const image = await inspector.inspectImage("coprobe");
  assert.equal(image.bytes, bytes.length);
  assert.equal(image.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(decodes, 1);
  assert.equal(requests, 3);
  assert.ok(
    responses.every((response) => response.bodyUsed && !requiredFixture(response.body).locked),
  );
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
  assert.equal(inspector.providerMetrics.game_requests, 1);
  assert.equal(inspector.providerMetrics.image_bytes, bytes.length);
});

void test("provider response lifecycle preserves malformed JSON and missing-body failures", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const response = new Response("{");
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("invalid response must not decode"),
    async () => response,
  );
  const failure = await inspector.inspectGame(lifecycleIdentity).catch((error: unknown) => error);
  assert.ok(failure instanceof SyntaxError);
  await assert.rejects(inspector.inspectGame(lifecycleIdentity), (error) => error === failure);
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
  assert.equal(requiredFixture(response.body).locked, false);
  const empty = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("missing response must not decode"),
    async () => new Response(null, { headers: { "Content-Type": "image/jpeg" } }),
  );
  await assert.rejects(empty.inspectImage("coprobe"), /byte contract/);
});

void test("unknown-length image exceeding its per-response ceiling remains a security refusal", async () => {
  const { createIgdbInspector, ArtworkBatchExhausted } = await import("./inspect-igdb-artwork.mts");
  const inspector = createIgdbInspector(
    lifecycleCredentials(),
    () => assert.fail("oversized image cannot decode"),
    async () =>
      new Response(new Uint8Array(16 * 1024 * 1024 + 1), {
        headers: { "content-type": "image/jpeg" },
      }),
  );
  await assert.rejects(
    inspector.inspectImage("oversized"),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ArtworkBatchExhausted) &&
      /byte contract/.test(error.message),
  );
});
