import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ArtworkCatalog } from "./inspect-igdb-artwork.mts";

import { requiredFixture, record, text, root } from "./fixtures/catalog-generator-fixtures.mts";

function rejectedReason(result: PromiseRejectedResult): unknown {
  return result.reason;
}

const providerClockStart = Date.UTC(2026, 9, 3, 8);

async function flushProviderTimers(context: TestContext) {
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(0);
  await new Promise((resolve) => setImmediate(resolve));
}

async function capturedMetadataBackoff(
  context: TestContext,
  {
    status = 429,
    retryAfter = "2",
    responseDelay = 0,
  }: { status?: number; retryAfter?: string | null; responseDelay?: number } = {},
) {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-backoff-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: providerClockStart });
  const calls: number[] = [];
  const inspector = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata must not decode"),
    async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(requiredFixture(options.signal).aborted, false);
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      assert.equal(url, "https://api.igdb.com/v4/games");
      calls.push(Date.now());
      if (calls.length === 1) context.mock.timers.tick(responseDelay);
      return Response.json([], {
        status: calls.length === 1 ? status : 200,
        headers: calls.length === 1 && retryAfter !== null ? { "Retry-After": retryAfter } : {},
      });
    },
  );
  const request = (id: number) =>
    inspector.inspectGame({
      game_id: id,
      slug: `probe-${id}`,
      names: [`Probe ${id}`],
      evidence_url: "https://example.org/probe",
    });
  const first = request(101).catch((error: unknown) => error);
  await flushProviderTimers(context);
  await first;
  return { inspector, calls, request };
}

for (const [status, retryAfter] of [
  [429, "2"],
  [503, "2"],
  [429, new Date(providerClockStart + 2000).toUTCString()],
  [503, "Saturday, 03-Oct-26 08:00:02 GMT"],
  [429, "Sat Oct  3 08:00:02 2026"],
  [503, "Sat Oct 03 08:00:02 2026"],
] as const) {
  void test(`metadata${status} honors Retry-After ${retryAfter}`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { status, retryAfter });
    const next = fixture.request(102);
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1, "request must not escape at the ordinary300ms floor");
    context.mock.timers.tick(1699);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1, "request must not escape before the full provider pause");
    context.mock.timers.tick(1);
    await flushProviderTimers(context);
    await next;
    assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 2000]);
    assert.equal(fixture.inspector.providerMetrics.game_requests, 2);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

void test("HTTP-date metadata backoff preserves UTC semantics across process timezones", (context) => {
  const env = { ...process.env };
  // The outer runner marks its workers; a new independent runner must not
  // inherit that marker and silently refuse recursive discovery.
  delete env.NODE_TEST_CONTEXT;
  for (const [timezone, offset] of [
    ["Etc/UTC", 0],
    ["America/New_York", 240],
    ["Asia/Tokyo", -540],
    ["Pacific/Kiritimati", -840],
    ["Asia/Kathmandu", -345],
  ] as const) {
    // A fresh process prevents timezone changes from affecting other tests.
    // Observe the actual timezone so an ignored TZ cannot manufacture coverage.
    const verifyTimezone = `import assert from "node:assert/strict"; assert.equal(new Date("2026-10-03T08:00:00Z").getTimezoneOffset(), ${offset});`;
    const result = spawnSync(
      process.execPath,
      [
        `--import=data:text/javascript,${encodeURIComponent(verifyTimezone)}`,
        "--test",
        "--test-timeout=30000",
        "--test-reporter=spec",
        "--test-name-pattern=^(metadata.*honors Retry-After|unusable or elapsed Retry-After|Retry-After beyond the finite batch budget)",
        "scripts/catalog-artwork-backoff.test.mts",
      ],
      { cwd: root, env: { ...env, TZ: timezone }, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.error, undefined, `${timezone}: ${result.error}`);
    assert.equal(result.status, 0, `${timezone}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /metadata429 honors Retry-After Sat Oct  3 08:00:02 2026/);
    assert.match(result.stdout, /unusable or elapsed Retry-After Sat Oct  3 07:59:59 2026/);
    assert.match(
      result.stdout,
      /Retry-After beyond the finite batch budget.*Sat Oct 03 08:15:01 2026/,
    );
    const passed = result.stdout.match(/ℹ pass (\d+)/);
    assert.ok(passed, `${timezone}: child must report executed tests`);
    context.diagnostic(
      `${timezone}: ${requiredFixture(passed[1])} selected cases passed; observed offset ${offset}`,
    );
  }
});

for (const retryAfter of [
  null,
  "invalid",
  "-1",
  "1.5",
  "0",
  "Sat, 03 Oct 0030 08:00:00 GMT",
  "Sat Oct  3 08:00:00 0030",
  "Tue, 31 Nov 2026 08:00:00 GMT",
  "Tuesday, 31-Nov-26 08:00:00 GMT",
  "Tue Nov 31 08:00:00 2026",
  "Saturday, 03-Oct-76 08:00:01 GMT",
  "Sat Oct  3 07:59:59 2026",
  new Date(providerClockStart - 1000).toUTCString(),
]) {
  void test(`unusable or elapsed Retry-After ${retryAfter} preserves the metadata rate floor`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { retryAfter });
    const next = fixture.request(102);
    await flushProviderTimers(context);
    context.mock.timers.tick(299);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1);
    context.mock.timers.tick(1);
    await flushProviderTimers(context);
    await next;
    assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 300]);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

void test("successful metadata ignores Retry-After and preserves ordinary pacing", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { status: 200, retryAfter: "900" });
  const next = fixture.request(102);
  await flushProviderTimers(context);
  context.mock.timers.tick(300);
  await flushProviderTimers(context);
  await next;
  assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 300]);
});

void test("Retry-After seconds start when the unavailable response arrives", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { responseDelay: 500 });
  const next = fixture.request(102);
  await flushProviderTimers(context);
  context.mock.timers.tick(1999);
  await flushProviderTimers(context);
  assert.equal(fixture.calls.length, 1);
  context.mock.timers.tick(1);
  await flushProviderTimers(context);
  await next;
  assert.deepEqual(fixture.calls, [providerClockStart, providerClockStart + 2500]);
});

void test("deadline expiry while a metadata wait resolves does not count or send a request", async (context) => {
  const fixture = await capturedMetadataBackoff(context);
  const next = fixture.request(102).catch((error: unknown) => error);
  await flushProviderTimers(context);
  context.mock.timers.tick(15 * 60 * 1000);
  await flushProviderTimers(context);
  assert.match(text(record(await next).message), /batch deadline/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
});

void test("metadata pacing preserves the800request cap without repeated authentication", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { retryAfter: null });
  for (let request = 1; request < 799; request++) {
    const next = fixture.request(101 + request);
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    await next;
  }
  const last = Promise.allSettled([fixture.request(900), fixture.request(901)]);
  await flushProviderTimers(context);
  context.mock.timers.tick(300);
  await flushProviderTimers(context);
  const results = await last;
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(
    text(
      record(
        rejectedReason(requiredFixture(results.find((result) => result.status === "rejected"))),
      ).message,
    ),
    /metadata budget/,
  );
  await assert.rejects(fixture.request(901), /metadata budget/);
  assert.equal(fixture.calls.length, 800);
  assert.equal(fixture.inspector.providerMetrics.game_requests, 800);
  assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
});

void test("metadata backoff uses the existing batch cancellation signal", async (context) => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-cancel-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  let requests = 0;
  const inspector = createIgdbInspector(
    privateFile,
    () => assert.fail("metadata must not decode"),
    async (url) => {
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      assert.equal(url, "https://api.igdb.com/v4/games");
      requests++;
      return Response.json([], { status: 503, headers: { "Retry-After": "600" } });
    },
  );
  const identity = {
    game_id: 101,
    slug: "probe",
    names: ["Probe"],
    evidence_url: "https://example.org/probe",
  };
  await assert.rejects(inspector.inspectGame(identity), /identity request unavailable/);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  let waitSignals = 0;
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    if (milliseconds <= 15000) return timeout(milliseconds);
    waitSignals++;
    return controller.signal;
  });
  const pending = inspector.inspectGame(identity);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(waitSignals, 1);
  assert.equal(requests, 1);
  assert.equal(inspector.providerMetrics.game_requests, 1);
  assert.equal(inspector.providerMetrics.authentication_requests, 1);
});

void test("over-budget metadata backoff retains accepted mappings and leaves authoring input unchanged", async (context) => {
  const { prepareCatalogArtwork } = await import("./inspect-igdb-artwork.mts");
  const fixture = await capturedMetadataBackoff(context, { retryAfter: "900" });
  const accepted: ArtworkCatalog = {
    ports: [
      {
        id: "probe",
        name: "Probe",
        project_url: "https://example.org/probe",
        presentation: {
          artwork: {
            game_id: 101,
            cover_id: 202,
            image_id: "coexisting",
            image_sha256: "a".repeat(64),
            game_slug: "probe",
            match_kind: "port",
          },
        },
      },
    ],
  };
  const before = structuredClone(accepted);
  const result = await prepareCatalogArtwork(accepted, {
    ...fixture.inspector,
    acceptedCatalog: accepted,
    refreshPortIds: ["probe"],
    identities: {
      probe: {
        port: {
          game_id: 101,
          slug: "probe",
          names: ["Probe"],
          evidence_url: "https://example.org/probe",
        },
      },
    },
  });
  assert.deepEqual(result.catalog, accepted);
  assert.deepEqual(accepted, before);
  assert.equal(
    requiredFixture(result.records[0]).reason,
    "accepted-mapping-retained-after-unavailable-refresh",
  );
  assert.equal(record(requiredFixture(result.records[0]).checks).live_refresh_passed, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.inspector.providerMetrics.image_requests, 0);
});

for (const retryAfter of [
  "900",
  "901",
  "9".repeat(200),
  "9007199254740991",
  "Thursday, 01-Jan-60 08:00:00 GMT",
  "Saturday, 03-Oct-76 08:00:00 GMT",
  "Sat Oct  3 08:15:00 2026",
  "Sat Oct 03 08:15:01 2026",
  new Date(providerClockStart + 901000).toUTCString(),
]) {
  void test(`Retry-After beyond the finite batch budget refuses another metadata request: ${retryAfter.slice(0, 40)}`, async (context) => {
    const fixture = await capturedMetadataBackoff(context, { retryAfter });
    const next = fixture.request(102).then(
      () => assert.fail("over-budget pause cannot send"),
      (error: unknown) => error,
    );
    await flushProviderTimers(context);
    context.mock.timers.tick(300);
    await flushProviderTimers(context);
    assert.equal(fixture.calls.length, 1);
    assert.match(text(record(await next).message), /batch deadline/);
    assert.equal(Date.now(), providerClockStart + 300, "no unbounded sleep");
    assert.equal(fixture.inspector.providerMetrics.game_requests, 1);
    assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
  });
}

void test("bounded provider operations resume after the actual quota reset without reauthentication", async (context) => {
  const fixture = await capturedMetadataBackoff(context, { retryAfter: "3600" });
  assert.equal(
    fixture.inspector.batchStatus().metadata_retry_at,
    new Date(providerClockStart + 3600000).toISOString(),
  );
  fixture.inspector.beginBatch();
  await assert.rejects(fixture.request(102), /batch deadline/);
  assert.equal(fixture.calls.length, 1);
  context.mock.timers.tick(3600000);
  fixture.inspector.beginBatch();
  await fixture.request(102);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.inspector.providerMetrics.authentication_requests, 1);
});

void test("explicit cancellation refuses provider operations before transport admission", async () => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const control = new AbortController();
  control.abort();
  const inspector = createIgdbInspector(
    null,
    () => assert.fail("cancelled operation cannot decode"),
    async () => assert.fail("cancelled operation cannot send"),
    { signal: control.signal },
  );
  await assert.rejects(inspector.inspectImage("cancelled"), { name: "AbortError" });
  assert.equal(inspector.providerMetrics.image_requests, 0);
});

void test("valid metadata crossing residual operation bytes automatically completes in a fresh batch", async (context) => {
  const { createIgdbInspector } = await import("./inspect-igdb-artwork.mts");
  const { prepareArtworkWorkset } = await import("./artwork-preparation-progress.mts");
  const scratch = mkdtempSync(join(tmpdir(), "portcove-metadata-byte-continuation-"));
  const privateFile = join(scratch, "private-fixture.json");
  writeFileSync(privateFile, JSON.stringify({ client_id: "fixture", client_secret: "fixture" }));
  context.mock.timers.enable({ apis: ["Date"], now: providerClockStart });
  const queries = new Map<number, number>();
  const inspector = createIgdbInspector(
    privateFile,
    () => ({ width: 264, height: 374, format: "jpeg", validator: "portcove-core" }),
    async (url, options) => {
      if (url === "https://id.twitch.tv/oauth2/token")
        return Response.json({ access_token: "fixture" });
      if (url.startsWith("https://images.igdb.com/"))
        return new Response("fixture image", { headers: { "content-type": "image/jpeg" } });
      assert.equal(url, "https://api.igdb.com/v4/games");
      const index = Number(text(options.body).match(/Scale ([0-9]+)/u)![1]);
      queries.set(index, (queries.get(index) ?? 0) + 1);
      context.mock.timers.tick(300);
      const body = JSON.stringify([
        {
          id: index + 1,
          name: `Scale ${index}`,
          slug: `scale-${index}`,
          websites: [{ url: `https://example.org/scale-${index}` }],
          cover: { id: index + 1, image_id: `scale${index}` },
        },
      ]).padEnd(index === 31 ? 512 * 1024 : 1024 * 1024, " ");
      return new Response(body, { headers: { "content-length": String(body.length) } });
    },
  );
  try {
    const catalog = {
      ports: Array.from({ length: 34 }, (_, index) => ({
        id: `scale-${index}`,
        name: `Scale ${index}`,
        project_url: `https://example.org/scale-${index}`,
      })),
    };
    const result = await prepareArtworkWorkset(catalog, {
      root: scratch,
      inspector,
      identities: {},
      validatorIdentity: null,
      selectedPortIds: catalog.ports.map((port) => port.id),
    });
    assert.equal(result.continuation.complete, true);
    assert.equal(result.continuation.batches, 2);
    assert.ok([...queries].filter(([index]) => index < 32).every(([, calls]) => calls === 1));
    assert.equal(queries.get(32), 2);
    assert.equal(queries.get(33), 2);
    assert.equal(inspector.providerMetrics.authentication_requests, 1);
    assert.ok(inspector.providerMetrics.metadata_bytes > 32 * 1024 * 1024);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(scratch, { recursive: true, force: true });
  }
});
