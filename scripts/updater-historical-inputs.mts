import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";

// Exact published updater-less inputs, independently retained with release
// metadata/checksums in the 2026-10-28 native qualification custody. These are
// historical fixture pins, not a catalog, signing policy or publication grant.
const release = {
  version: "0.1.0-alpha.2",
  source_commit: "27328c8a1b30bf92868bcf3cde313f2720c8fd1e",
  release_tag: "v0.1.0-alpha.2",
  release_url: "https://github.com/boburning/portcove/releases/tag/v0.1.0-alpha.2",
} as const;
const packagePins = {
  appimage: {
    name: "Portcove_0.1.0-alpha.2_amd64.AppImage",
    release_asset_id: 550866257,
    bytes: 89795064,
    sha256: "42588ac5f637f7b48ad08c8154fee53d40c51486ad789c36e71593f30627709d",
  },
  cli_archive: {
    name: "portcove-linux-x86_64.tar.gz",
    release_asset_id: 550866327,
    bytes: 8907510,
    sha256: "c4c5faa9adfc3c3427e24cf69fa0a5d44b7167ee2444a7638d68b8d4d732bd74",
  },
  cli: {
    name: "portcove",
    bytes: 24067440,
    sha256: "1652c89fb12e562b4dc4cb89e33e3fd0bb51f4cebe45caf26d6f6cce06842334",
  },
} as const;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type FilePin = { name: string; bytes: number; sha256: string };

function verifyBytes(bytes: Buffer, pin: FilePin) {
  assert.equal(bytes.length, pin.bytes, `Historical ${pin.name} byte count differs`);
  assert.equal(sha(bytes), pin.sha256, `Historical ${pin.name} digest differs`);
  return bytes;
}

async function download(pin: FilePin) {
  let url = `https://github.com/boburning/portcove/releases/download/${release.release_tag}/${pin.name}`;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 1; redirects++) {
    const response = await fetch(url, { redirect: "manual", signal });
    if (response.status === 302) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      assert.ok(location && redirects === 0, "Historical release redirect limit");
      const next = new URL(location, url);
      assert.ok(
        next.protocol === "https:" &&
          next.hostname === "release-assets.githubusercontent.com" &&
          !next.username &&
          !next.password &&
          !next.port,
        "Historical release redirect refused",
      );
      url = next.href;
      continue;
    }
    assert.equal(response.status, 200, "Historical public release unavailable");
    assert.ok(response.body);
    const chunks: Uint8Array[] = [];
    let count = 0;
    for await (const raw of response.body) {
      const chunk: unknown = raw;
      assert.ok(chunk instanceof Uint8Array, "Historical download stream representation");
      count += chunk.byteLength;
      assert.ok(count <= pin.bytes, "Historical download byte bound");
      chunks.push(chunk);
    }
    return verifyBytes(Buffer.concat(chunks), pin);
  }
  throw new Error("Historical release redirect limit");
}

/** This fixed, integrity-checked archive has exactly one known CLI member.
 * No archive-controlled name, size or extension is parsed or extracted. */
export function extractHistoricalLinuxCli(archive: Buffer) {
  verifyBytes(archive, packagePins.cli_archive);
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  assert.equal(tar.length, 24074240, "Historical CLI expanded archive differs");
  return verifyBytes(tar.subarray(512, 512 + packagePins.cli.bytes), packagePins.cli);
}

export async function prepareHistoricalLinuxInputs(projectRoot: string, directory: string) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const root = await assertOwnedUnlinkedPath(projectRoot, directory, "historical fixture");
  await mkdir(root, { mode: 0o700 });
  const appimage = await download(packagePins.appimage);
  const archive = await download(packagePins.cli_archive);
  const cli = extractHistoricalLinuxCli(archive);
  for (const [kind, bytes] of [
    ["appimage", appimage],
    ["cli_archive", archive],
    ["cli", cli],
  ] as const) {
    await writeFile(path.join(root, packagePins[kind].name), bytes, { flag: "wx", mode: 0o600 });
  }
  await chmod(path.join(root, packagePins.appimage.name), 0o755);
  await chmod(path.join(root, packagePins.cli.name), 0o700);
  const manifest = {
    schema_version: 1,
    platform: "linux-x86_64",
    ...release,
    payload_signature: null,
    metadata_signatures: null,
    feed_identity: null,
    scope:
      "published updater-less historical inputs; no authenticated update or publication authority",
    files: Object.fromEntries(
      Object.entries(packagePins).map(([kind, pin]) => [
        kind,
        {
          ...pin,
          path: path.join(root, pin.name),
        },
      ]),
    ),
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return manifestPath;
}

export async function readHistoricalLinuxInputs(projectRoot: string, manifestPath: string) {
  const file = await assertOwnedUnlinkedPath(projectRoot, manifestPath, "historical manifest");
  const manifestBytes = await readBoundedPublicBuildInputFile(
    projectRoot,
    path.relative(projectRoot, file),
    65536,
  );
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(isRecord(manifest));
  assert.deepEqual(
    Object.keys(manifest).sort(),
    [
      "schema_version",
      "platform",
      ...Object.keys(release),
      "payload_signature",
      "metadata_signatures",
      "feed_identity",
      "scope",
      "files",
    ].sort(),
  );
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.platform, "linux-x86_64");
  for (const [key, value] of Object.entries(release)) assert.equal(manifest[key], value);
  for (const key of ["payload_signature", "metadata_signatures", "feed_identity"])
    assert.equal(manifest[key], null, "Updater-less historical signatures/feed must remain absent");
  assert.equal(
    manifest.scope,
    "published updater-less historical inputs; no authenticated update or publication authority",
  );
  assert.ok(isRecord(manifest.files));
  assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(packagePins).sort());
  const files = {} as Record<
    keyof typeof packagePins,
    FilePin & { path: string; release_asset_id?: number }
  >;
  for (const kind of ["appimage", "cli_archive", "cli"] as const) {
    const pin = packagePins[kind];
    const item: unknown = manifest.files[kind];
    assert.ok(isRecord(item));
    assert.deepEqual(Object.keys(item).sort(), [...Object.keys(pin), "path"].sort());
    for (const [key, value] of Object.entries(pin)) assert.equal(item[key], value);
    assert.equal(typeof item.path, "string");
    assert.ok(typeof item.path === "string");
    assert.ok(path.isAbsolute(item.path));
    await assertOwnedUnlinkedPath(projectRoot, item.path, `historical ${kind}`);
    verifyBytes(
      await readBoundedPublicBuildInputFile(
        projectRoot,
        path.relative(projectRoot, item.path),
        pin.bytes,
      ),
      pin,
    );
    files[kind] = { ...pin, path: item.path };
  }
  return {
    schema_version: 1,
    platform: "linux-x86_64",
    ...release,
    files,
    payload_signature: null,
    metadata_signatures: null,
    feed_identity: null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    5,
    "usage: updater-historical-inputs.mts prepare|verify PROJECT_ROOT PATH",
  );
  const [command, root, target] = process.argv.slice(2);
  assert.ok(command === "prepare" || command === "verify");
  console.log(
    command === "prepare"
      ? await prepareHistoricalLinuxInputs(path.resolve(root!), path.resolve(target!))
      : JSON.stringify(await readHistoricalLinuxInputs(path.resolve(root!), path.resolve(target!))),
  );
}
