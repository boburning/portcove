import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  extractHistoricalLinuxCli,
  prepareHistoricalLinuxInputs,
  readHistoricalLinuxInputs,
} from "./updater-historical-inputs.mts";
import { createHash } from "node:crypto";
import {
  downloadPinnedPortcoveReleaseAsset,
  downloadPortcoveReleaseAsset,
  fetchPublicPortcoveApi,
} from "./portcove-release-download.mts";

function historicalManifest(root: string) {
  return {
    schema_version: 1,
    platform: "linux-x86_64",
    version: "0.1.0-alpha.2",
    source_commit: "27328c8a1b30bf92868bcf3cde313f2720c8fd1e",
    release_tag: "v0.1.0-alpha.2",
    release_url: "https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2",
    payload_signature: null,
    metadata_signatures: null,
    feed_identity: null,
    scope:
      "published updater-less historical inputs; no authenticated update or publication authority",
    files: {
      appimage: {
        name: "Portcove_0.1.0-alpha.2_amd64.AppImage",
        release_asset_id: 550866257,
        bytes: 89795064,
        sha256: "42588ac5f637f7b48ad08c8154fee53d40c51486ad789c36e71593f30627709d",
        path: path.join(root, "appimage"),
      },
      cli_archive: {
        name: "portcove-linux-x86_64.tar.gz",
        release_asset_id: 550866327,
        bytes: 8907510,
        sha256: "c4c5faa9adfc3c3427e24cf69fa0a5d44b7167ee2444a7638d68b8d4d732bd74",
        path: path.join(root, "archive"),
      },
      cli: {
        name: "portcove",
        bytes: 24067440,
        sha256: "1652c89fb12e562b4dc4cb89e33e3fd0bb51f4cebe45caf26d6f6cce06842334",
        path: path.join(root, "cli"),
      },
    },
  };
}

void test("historical custody refuses substituted identities and invented updater authority before payload access", async (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "historical-linux-identity-"));
  const filename = path.join(root, "manifest.json");
  const mutations: Array<(value: ReturnType<typeof historicalManifest>) => unknown> = [
    (value) => ({ ...value, schema_version: "1" }),
    (value) => ({ ...value, source_commit: "0".repeat(40) }),
    (value) => ({ ...value, platform: "windows-x86_64" }),
    (value) => ({ ...value, version: "0.1.0" }),
    (value) => ({ ...value, release_tag: "v0.1.0" }),
    (value) => ({ ...value, release_url: "https://example.invalid/release" }),
    (value) => ({ ...value, payload_signature: "retroactively invented" }),
    (value) => ({ ...value, metadata_signatures: [] }),
    (value) => ({ ...value, feed_identity: "https://example.invalid/feed" }),
    (value) => ({ ...value, extra_authority: true }),
    (value) => ({ ...value, files: { ...value.files, extra_payload: value.files.cli } }),
    (value) => ({
      ...value,
      files: { ...value.files, appimage: { ...value.files.appimage, release_asset_id: 1 } },
    }),
  ];
  for (const mutate of mutations) {
    await writeFile(filename, JSON.stringify(mutate(historicalManifest(root))));
    await assert.rejects(readHistoricalLinuxInputs(root, filename), (error) => {
      assert.notEqual(
        (error as NodeJS.ErrnoException).code,
        "ENOENT",
        "Must reject metadata before opening absent payloads",
      );
      return true;
    });
  }
});

void test("historical custody bounds actual manifest reads and rejects escaped or changed files", async (t) => {
  const root = disposableDirectory(t, path.join(os.tmpdir(), "historical-linux-files-"));
  const filename = path.join(root, "manifest.json");
  await writeFile(filename, Buffer.alloc(65537, 32));
  await assert.rejects(readHistoricalLinuxInputs(root, filename), /bounded/u);
  const outside = historicalManifest(root);
  outside.files.appimage.path = path.join(root, "..", "outside");
  await writeFile(filename, JSON.stringify(outside));
  await assert.rejects(readHistoricalLinuxInputs(root, filename), /child path inside/u);
  const changed = historicalManifest(root);
  await writeFile(changed.files.appimage.path, "inert substitution, never executed");
  await writeFile(filename, JSON.stringify(changed));
  await assert.rejects(readHistoricalLinuxInputs(root, filename), /byte count differs/u);
});

void test("historical CLI decoding rejects unadmitted compressed bytes before decompression", () => {
  assert.throws(() => extractHistoricalLinuxCli(Buffer.alloc(8907510)), /digest differs/u);
  assert.throws(
    () => extractHistoricalLinuxCli(Buffer.from("not a gzip archive")),
    /byte count differs/u,
  );
});

void test(
  "historical inputs keep their request, redirect, bound and pin behavior on the shared transport",
  { skip: process.platform !== "linux" || process.arch !== "x64" },
  async (t) => {
    const root = disposableDirectory(t, path.join(os.tmpdir(), "historical-linux-transport-"));
    const appimage = "Portcove_0.1.0-alpha.2_amd64.AppImage";
    const origin = `https://github.com/boburning/portcove/releases/download/v0.1.0-alpha.2/${appimage}`;
    let destination = "https://release-assets.githubusercontent.com/object";
    let body: Buffer = Buffer.alloc(89795064);
    const requests: { url: string; redirect: unknown; headers: unknown }[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
      requests.push({ url, redirect: options.redirect, headers: options.headers });
      if (url === origin) return Response.redirect(destination, 302);
      return new Response(body);
    });
    let attempt = 0;
    const prepare = () =>
      prepareHistoricalLinuxInputs(root, path.join(root, `inputs-${++attempt}`));
    // Exact-size substituted bytes fail the historical pin with its own wording.
    await assert.rejects(prepare(), new RegExp(`Historical ${appimage} digest differs`, "u"));
    assert.deepEqual(requests, [
      { url: origin, redirect: "manual", headers: undefined },
      { url: destination, redirect: "manual", headers: undefined },
    ]);
    body = Buffer.alloc(16);
    await assert.rejects(prepare(), new RegExp(`Historical ${appimage} byte count differs`, "u"));
    body = Buffer.alloc(89795065);
    await assert.rejects(prepare(), /Historical download byte bound/u);
    destination = "https://other.example/object";
    await assert.rejects(prepare(), /Historical release redirect refused/u);
    assert.ok(!requests.some((request) => request.url === destination));
  },
);

void test("published release downloads require exact coordinates, delivery origin and pinned bytes", async (t) => {
  const bytes = Buffer.from("pinned");
  const pin = {
    name: "tool.tar.gz",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let destination = "https://release-assets.githubusercontent.com/object";
  let body = bytes;
  let status = 200;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push(url);
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(options.redirect, "error");
      // Anonymous: no authorization header is ever sent.
      assert.equal(
        Object.keys(options.headers as Record<string, string>).some(
          (name) => name.toLowerCase() === "authorization",
        ),
        false,
      );
      return new Response(JSON.stringify({ id: 1 }), { status });
    }
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers, undefined);
    if (url === "https://github.com/boburning/portcove/releases/download/v1/tool.tar.gz")
      return Response.redirect(destination, 302);
    return new Response(body);
  });
  assert.deepEqual(await downloadPinnedPortcoveReleaseAsset("v1", pin), bytes);
  assert.equal(requests.length, 2);
  await assert.rejects(
    downloadPinnedPortcoveReleaseAsset("v1", { ...pin, name: "../other" }),
    /coordinate/u,
  );
  await assert.rejects(downloadPortcoveReleaseAsset("v1", "a", 0), /bound/u);
  assert.equal(requests.length, 2);
  body = Buffer.from("denied");
  await assert.rejects(downloadPinnedPortcoveReleaseAsset("v1", pin), /digest differs/u);
  body = Buffer.from("oversize");
  await assert.rejects(
    downloadPinnedPortcoveReleaseAsset("v1", pin),
    /Portcove download byte bound/u,
  );
  destination = "https://other.example/object";
  await assert.rejects(downloadPinnedPortcoveReleaseAsset("v1", pin), /redirect refused/u);
  assert.ok(!requests.includes(destination));
  assert.deepEqual(await fetchPublicPortcoveApi("releases/tags/v1"), { id: 1 });
  assert.equal(requests.at(-1), "https://api.github.com/repos/boburning/portcove/releases/tags/v1");
  await assert.rejects(fetchPublicPortcoveApi("../users/x"), /Invalid public/u);
  await assert.rejects(fetchPublicPortcoveApi("releases/tags/v1", 4), /API byte bound/u);
  status = 403;
  await assert.rejects(fetchPublicPortcoveApi("releases/tags/v1"), /unavailable \(403\)/u);
});
