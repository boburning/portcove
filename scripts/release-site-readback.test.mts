import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";
import { capacityDigest } from "./release-capacity.mts";
import { GitHubApiError } from "./github-api.mts";
import { composeSiteFiles, readComposedSite } from "./release-site-composer.mts";
import {
  readPublicApplicationSite,
  readPublicApplicationSiteMarker,
  materializePublishedApplicationComponent,
  observeInitialApplicationSite,
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
} from "./release-site-readback.mts";

const origin = "https://boburning.github.io/portcove/";

async function initialFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-initial-site-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const state = { owner: true, scope: "repo", project: 404, parent: 404, change: false };
  const api = {
    request(method: string, endpoint: string) {
      assert.equal(method, "GET");
      calls.push(endpoint);
      const headers = new Map([["x-oauth-scopes", state.scope]]);
      if (endpoint === "user")
        return {
          status: 200,
          headers,
          body: { id: state.owner ? 43177418 : 1, login: "boburning" },
        };
      if (endpoint === "repos/boburning/portcove")
        return {
          status: 200,
          headers,
          body: {
            id: 1354613114,
            full_name: "boburning/portcove",
            private: false,
            owner: { id: 43177418 },
            permissions: { admin: true },
          },
        };
      const status =
        endpoint === "repos/boburning/portcove/pages"
          ? state.change && calls.length > 4
            ? 200
            : state.project
          : endpoint === "repos/boburning/boburning.github.io"
            ? state.parent
            : 500;
      if (status === 404) throw new GitHubApiError("command_failed", "Not Found", { status });
      return { status, headers, body: {} };
    },
  };
  const fetcher = (async (url, options) => {
    assert.ok(typeof url === "string");
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.equal(
      Object.keys(options?.headers ?? {}).some((key) => /auth/i.test(key)),
      false,
    );
    return response(url, Buffer.from("not found"), 404);
  }) as typeof fetch;
  return { root, calls, state, api, fetcher };
}

void test("initial setup observes owner-visible unconfigured project and parent namespace around fixed credential-free 404 routes", async (t) => {
  const f = await initialFixture(t);
  const result = await observeInitialApplicationSite(f.root, { api: f.api, fetch: f.fetcher });
  assert.equal(result.receipt.authority, "none");
  assert.equal(result.receipt.evidence_scope, "injected-provider");
  assert.equal(result.receipt.observations.length, 6);
  assert.equal(f.calls.length, 8);
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(result.directory, "initial-site.json")))
      .digest("hex"),
    result.sha256,
  );
});

void test("public 404 alone cannot appoint an empty site: wrong owner, limited visibility and existing namespaces refuse", async (t) => {
  const f = await initialFixture(t);
  for (const kind of ["owner", "scope", "project", "parent"] as const) {
    const before = { ...f.state };
    if (kind === "owner") f.state.owner = false;
    else if (kind === "scope") f.state.scope = "read:user";
    else f.state[kind] = 200;
    await assert.rejects(
      observeInitialApplicationSite(f.root, {
        api: f.api,
        fetch: async () => assert.fail("provider preimage refused before HTTP"),
      }),
      /initial site observation refused/,
    );
    Object.assign(f.state, before);
  }
});

void test("changing injected setup options while awaiting cannot relabel evidence or replace the fixed reader", async (t) => {
  const f = await initialFixture(t);
  const options: Parameters<typeof observeInitialApplicationSite>[1] = { api: f.api };
  options.fetch = async (...args) => {
    delete options.api;
    delete options.fetch;
    return f.fetcher(...args);
  };
  const result = await observeInitialApplicationSite(f.root, options);
  assert.equal(result.receipt.evidence_scope, "injected-provider");
  assert.equal(f.calls.length, 8);
});

void test("initial observation retains partial facts and refuses present routes, unavailable HTTP and changing provider state", async (t) => {
  const f = await initialFixture(t);
  for (const status of [200, 301, 403, 500]) {
    await assert.rejects(
      observeInitialApplicationSite(f.root, {
        api: f.api,
        fetch: async (url) => {
          assert.ok(typeof url === "string");
          return response(url, Buffer.alloc(0), status);
        },
      }),
      /initial site observation refused/,
    );
  }
  f.calls.length = 0;
  f.state.change = true;
  await assert.rejects(
    observeInitialApplicationSite(f.root, { api: f.api, fetch: f.fetcher }),
    /refused/,
  );
  const records = await readdir(f.root);
  assert.equal(records.length, 5);
  for (const directory of records) {
    const record: unknown = JSON.parse(
      await readFile(path.join(f.root, directory, "refusal.json"), "utf8"),
    );
    assert.ok(isRecord(record));
    assert.equal(record.automatic_retry, false);
    assert.ok(Array.isArray(record.observations) && record.observations.length >= 2);
  }
});
function fixture() {
  const files = new Map([
    [".nojekyll", Buffer.alloc(0)],
    ["application/metadata/timestamp.json", Buffer.from("signed-disposable-timestamp")],
    ["catalog/metadata/1.root.json", Buffer.from("unchanged-independent-catalog")],
    ["catalog/targets/game+variant.json", Buffer.from("valid-composer-path")],
  ]);
  const unsigned = {
    schema_version: 1,
    previous_generation: "a".repeat(64),
    application_root_sha256: "b".repeat(64),
    files: [...files].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const marker = { ...unsigned, generation: capacityDigest(unsigned) };
  files.set("publication.json", Buffer.from(JSON.stringify(marker)));
  return { files, marker };
}
function response(url: string, bytes: Buffer, status = 200) {
  const result = new Response(bytes, { status });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function componentFixture() {
  const files = new Map([
    [".nojekyll", Buffer.alloc(0)],
    ["application/metadata/1.root.json", Buffer.from("independently-pinned-root")],
    ["application/metadata/timestamp.json", Buffer.from("actual-verifier-still-required")],
    ["application/targets/retained.json", Buffer.from("unchanged-target")],
    ["catalog/targets/separate.json", Buffer.from("never-download-for-application-renewal")],
  ]);
  const inventory = [...files].map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  const root = inventory.find((file) => file.path.endsWith("1.root.json"))!.sha256;
  const unsigned = {
    schema_version: 1,
    previous_generation: null,
    application_root_sha256: root,
    files: inventory,
  };
  const marker = { ...unsigned, generation: capacityDigest(unsigned) };
  files.set("publication.json", Buffer.from(JSON.stringify(marker)));
  return {
    files,
    marker,
    expected: {
      site_generation_sha256: marker.generation,
      root_sha256: root,
      repository_sha256: capacityDigest(
        inventory
          .filter((file) => file.path.startsWith("application/"))
          .map((file) => ({ ...file, path: file.path.slice(12) })),
      ),
    },
  };
}

void test("whole-site custody retains catalog and history for composition, rejects imported custody and local mutation", async (t) => {
  const f = componentFixture();
  const parent = await mkdtemp(path.join(os.tmpdir(), "complete-public-site-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.credentials, "omit");
    calls.push(url.slice(origin.length));
    return response(url, f.files.get(url.slice(origin.length))!);
  });
  const result = await materializePublishedCompleteSite(f.expected, parent);
  const custody = await requirePublishedCompleteSite(result.receipt);
  const { cp, writeFile: writeNext } = await import("node:fs/promises");
  const updatedApplication = path.join(parent, "next-application");
  await cp(custody.application, updatedApplication, { recursive: true, errorOnExist: true });
  await writeNext(
    path.join(updatedApplication, "metadata/timestamp.json"),
    "next-disposable-timestamp",
  );
  const next = await composeSiteFiles({
    previous: custody.directory,
    expected_previous_generation: custody.generation.generation,
    application: updatedApplication,
    application_root_sha256: custody.pins.root_sha256,
    output_parent: parent,
  });
  const composed = await readComposedSite(
    next.output,
    next.generation.generation,
    f.expected.root_sha256,
  );
  assert.equal(
    composed.files.get("catalog/targets/separate.json")?.toString("utf8"),
    "never-download-for-application-renewal",
  );
  assert.equal(next.generation.previous_generation, f.expected.site_generation_sha256);
  assert.equal(
    await readFile(path.join(result.directory, "catalog/targets/separate.json"), "utf8"),
    "never-download-for-application-renewal",
  );
  assert.equal(
    await readFile(path.join(result.application, "targets/retained.json"), "utf8"),
    "unchanged-target",
  );
  assert.equal(result.receipt.authority, "none");
  assert.deepEqual(calls, [
    "publication.json",
    ...f.marker.files.map((file) => file.path),
    "publication.json",
  ]);
  await assert.rejects(
    requirePublishedCompleteSite(structuredClone(result.receipt)),
    /actual complete/,
  );
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(result.directory, "catalog/targets/separate.json"), "changed");
  await assert.rejects(requirePublishedCompleteSite(result.receipt), /prior site bytes/);
});

void test("whole-site acquisition refuses missing catalog, changing generation and wrong application pins with partial bytes retained", async (t) => {
  for (const mode of ["catalog", "bracket", "repository"] as const) {
    const f = componentFixture();
    const parent = await mkdtemp(path.join(os.tmpdir(), "complete-public-refusal-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    let markers = 0;
    const mock = t.mock.method(globalThis, "fetch", async (url: string) => {
      const name = url.slice(origin.length);
      if (name === "publication.json") markers++;
      return response(
        url,
        mode === "bracket" && markers === 2 ? Buffer.from("changed") : f.files.get(name)!,
        mode === "catalog" && name.startsWith("catalog/") ? 404 : 200,
      );
    });
    await assert.rejects(
      materializePublishedCompleteSite(
        { ...f.expected, ...(mode === "repository" ? { repository_sha256: "f".repeat(64) } : {}) },
        parent,
      ),
      /retain /,
    );
    const [directory] = await readdir(parent);
    const failure: unknown = JSON.parse(
      await readFile(path.join(parent, directory!, "refusal.json"), "utf8"),
    );
    assert.ok(isRecord(failure));
    assert.equal(failure.completed, false);
    assert.equal(failure.automatic_retry, false);
    mock.mock.restore();
  }
});

void test("fresh renewal materialization pins complete component, preserves history and never reads catalog", async (t) => {
  const f = componentFixture();
  const parent = await mkdtemp(path.join(os.tmpdir(), "public-component-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    calls.push(url);
    return response(url, f.files.get(url.slice(origin.length))!);
  });
  const result = await materializePublishedApplicationComponent(f.expected, parent);
  assert.equal(result.receipt.authority, "none");
  assert.equal(await readFile(result.root_path, "utf8"), "independently-pinned-root");
  assert.equal(
    await readFile(path.join(result.directory, "targets/retained.json"), "utf8"),
    "unchanged-target",
  );
  assert.equal(calls.length, 5);
  assert.equal(
    calls.some((url) => url.includes("/catalog/")),
    false,
  );
  assert.equal(
    await readFile(path.join(path.dirname(result.directory), "readback.json"), "utf8"),
    JSON.stringify(result.receipt),
  );
});

void test("wrong journal pins, changed bytes and changed generation retain partial materialization and refuse", async (t) => {
  for (const mode of ["generation", "root", "repository", "bytes", "bracket"] as const) {
    const f = componentFixture();
    const parent = await mkdtemp(path.join(os.tmpdir(), "public-component-refusal-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    let markerReads = 0;
    const mocked = t.mock.method(globalThis, "fetch", async (url: string) => {
      const name = url.slice(origin.length);
      if (name === "publication.json") markerReads++;
      return response(
        url,
        mode === "bytes" && name.endsWith("retained.json")
          ? Buffer.from("tampered")
          : mode === "bracket" && markerReads === 2
            ? Buffer.from("changed")
            : f.files.get(name)!,
      );
    });
    const expected = { ...f.expected };
    if (mode === "generation") expected.site_generation_sha256 = "f".repeat(64);
    if (mode === "root") expected.root_sha256 = "f".repeat(64);
    if (mode === "repository") expected.repository_sha256 = "f".repeat(64);
    await assert.rejects(materializePublishedApplicationComponent(expected, parent), /retain /u);
    const [retained] = await readdir(parent);
    const failure: unknown = JSON.parse(
      await readFile(path.join(parent, retained!, "refusal.json"), "utf8"),
    );
    assert.ok(isRecord(failure));
    assert.equal(failure.completed, false);
    assert.equal(failure.authority, "none");
    if (mode === "bracket")
      assert.equal(
        await readFile(path.join(parent, retained!, "repository/targets/retained.json"), "utf8"),
        "unchanged-target",
      );
    mocked.mock.restore();
  }
});

void test("renewal bounds and a missing pinned root refuse before component downloads", async (t) => {
  for (const mode of ["oversize", "missing-root"] as const) {
    const f = componentFixture();
    const parent = await mkdtemp(path.join(os.tmpdir(), "public-component-bounds-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const unsigned = {
      schema_version: 1,
      previous_generation: null,
      application_root_sha256: f.expected.root_sha256,
      files: f.marker.files
        .filter((file) => mode !== "missing-root" || !file.path.endsWith("1.root.json"))
        .map((file) =>
          mode === "oversize" && file.path.endsWith("timestamp.json")
            ? { ...file, bytes: 1024 * 1024 + 1 }
            : file,
        ),
    };
    const generation = capacityDigest(unsigned);
    const repository = capacityDigest(
      unsigned.files
        .filter((file) => file.path.startsWith("application/"))
        .map((file) => ({ ...file, path: file.path.slice(12) })),
    );
    let calls = 0;
    const mocked = t.mock.method(globalThis, "fetch", async (url: string) => {
      calls++;
      assert.equal(url, `${origin}publication.json`);
      return response(url, Buffer.from(JSON.stringify({ ...unsigned, generation })));
    });
    await assert.rejects(
      materializePublishedApplicationComponent(
        {
          ...f.expected,
          site_generation_sha256: generation,
          repository_sha256: repository,
        },
        parent,
      ),
      /retain /u,
    );
    assert.equal(calls, 1);
    mocked.mock.restore();
  }
});

void test("late marker bracket reads only the fixed marker, refuses stale/error responses and claims no file readback", async (context) => {
  const { files, marker } = fixture();
  for (const mode of ["current", "stale", "refused"] as const) {
    let calls = 0;
    const mocked = context.mock.method(
      globalThis,
      "fetch",
      async (input: string, options: RequestInit) => {
        calls++;
        assert.equal(input, `${origin}publication.json`);
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        return response(
          input,
          mode === "stale"
            ? Buffer.from(JSON.stringify({ ...marker, generation: "f".repeat(64) }))
            : files.get("publication.json")!,
          mode === "refused" ? 403 : 200,
        );
      },
    );
    if (mode === "current") {
      const result = await readPublicApplicationSiteMarker(marker);
      assert.equal(result.generation, marker.generation);
      assert.equal(result.scope, "expected generation marker only");
      assert.equal(Object.hasOwn(result, "files"), false);
    } else await assert.rejects(readPublicApplicationSiteMarker(marker), /public /u);
    assert.equal(calls, 1);
    mocked.mock.restore();
  }
});

void test("public readback checks every expected file, brackets generation and forwards no credentials", async (context) => {
  const { files, marker } = fixture();
  const calls: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: string, options: RequestInit) => {
    assert.ok(input.startsWith(origin));
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.deepEqual(Object.keys(options.headers!).sort(), ["Accept", "Cache-Control"]);
    const name = input.slice(origin.length);
    calls.push(name);
    return response(input, files.get(name)!);
  });
  const actual = await readPublicApplicationSite(marker);
  assert.equal(actual.authority, "none");
  assert.equal(actual.generation, marker.generation);
  assert.deepEqual(actual.files, marker.files);
  assert.deepEqual(calls, [
    "publication.json",
    ...marker.files.map((file) => file.path),
    "publication.json",
  ]);
});

void test("tampered/stale public bytes, changed marker, redirect and unavailable file refuse", async (context) => {
  for (const failure of [
    "stale",
    "bytes",
    "marker",
    "redirect",
    "missing",
    "stream",
    "length",
  ] as const) {
    const { files, marker } = fixture();
    let reads = 0;
    const mocked = context.mock.method(globalThis, "fetch", async (input: string) => {
      const name = input.slice(origin.length);
      let bytes = files.get(name)!;
      if (name === "publication.json") {
        reads++;
        if (failure === "stale")
          bytes = Buffer.from(JSON.stringify({ ...marker, generation: "f".repeat(64) }));
        if (failure === "marker" && reads === 2)
          bytes = Buffer.from(JSON.stringify(marker, null, 2));
      } else if (name.endsWith("timestamp.json")) {
        if (failure === "bytes") bytes = Buffer.from("x".repeat(bytes.length));
        if (failure === "stream") bytes = Buffer.alloc(bytes.length + 1);
        if (failure === "redirect") return response("https://untrusted.invalid/", bytes);
        if (failure === "missing") return response(input, bytes, 404);
        if (failure === "length") {
          const output = response(input, bytes);
          output.headers.set("content-length", "999999999999");
          return output;
        }
      }
      return response(input, bytes);
    });
    await assert.rejects(readPublicApplicationSite(marker), /public /u, failure);
    mocked.mock.restore();
  }
});

void test("caller-supplied malformed, unordered, duplicate or escaped inventories refuse before network", async (context) => {
  const calls = context.mock.method(globalThis, "fetch", () => {
    throw new Error("unexpected network");
  });
  const { marker } = fixture();
  for (const changes of [
    { files: [...marker.files].reverse() },
    { files: [marker.files[0], marker.files[0]] },
    { files: [{ ...marker.files[0], path: "catalog/../secrets" }] },
    { files: [{ ...marker.files[0], path: "catalog/.hidden/file" }] },
    { files: [{ ...marker.files[0], path: `catalog/${"a/".repeat(16)}file` }] },
    { files: [{ ...marker.files[0], bytes: 64 * 1024 * 1024 + 1 }] },
    { schema_version: 2 },
    { unknown: true },
  ])
    await assert.rejects(readPublicApplicationSite({ ...marker, ...changes }), /public /u);
  assert.equal(calls.mock.callCount(), 0);
});
