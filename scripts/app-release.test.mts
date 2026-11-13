import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFeed, classifyRelease, compareVersions, stampVersion } from "./app-release.mts";

void test("tags map to the owner-approved channels and environments", () => {
  assert.deepEqual(classifyRelease("0.1.0-preview.1"), {
    version: "0.1.0-preview.1",
    channel: "preview",
    prerelease: true,
    environment: "release",
    feeds: ["preview"],
  });
  assert.equal(classifyRelease("0.1.0").channel, "beta");
  assert.deepEqual(classifyRelease("0.2.3").feeds, ["beta", "preview"]);
  const stable = classifyRelease("1.0.0");
  assert.equal(stable.channel, "stable");
  assert.equal(stable.environment, "release-stable");
  assert.equal(stable.prerelease, false);
  for (const bad of ["0.1", "v0.1.0", "0.1.0-alpha.3", "0.1.0-preview", "01.0.0", "1.0.0-rc.1"])
    assert.throws(() => classifyRelease(bad));
});

void test("SemVer precedence orders previews below their release and above older releases", () => {
  const ordered = [
    "0.1.0-alpha.2",
    "0.1.0-preview.1",
    "0.1.0-preview.2",
    "0.1.0-preview.10",
    "0.1.0",
    "0.1.1",
    "0.2.0-preview.1",
    "0.2.0",
    "1.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(
      compareVersions(ordered[i]!, ordered[i + 1]!),
      -1,
      `${ordered[i]} < ${ordered[i + 1]}`,
    );
    assert.equal(compareVersions(ordered[i + 1]!, ordered[i]!), 1);
  }
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
});

void test("stamping rewrites exactly the three build version sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "app-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n\n[workspace.dependencies]\nx = { version = "1.2.3" }\n',
  );
  await writeFile(path.join(root, "apps/desktop/package.json"), '{"name":"d","version":"0.1.0"}\n');
  await writeFile(
    path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
    '{"productName":"Portcove","version":"0.1.0"}\n',
  );
  stampVersion(root, "0.1.1");
  const cargo = await readFile(path.join(root, "Cargo.toml"), "utf8");
  assert.match(cargo, /\[workspace\.package\]\nversion = "0\.1\.1"/u);
  assert.match(cargo, /x = \{ version = "1\.2\.3" \}/u);
  for (const file of ["apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"])
    assert.equal(JSON.parse(await readFile(path.join(root, file), "utf8")).version, "0.1.1");
  assert.throws(() => stampVersion(root, "not-a-version"));
});

void test("the feed binds every platform to its signed asset and refuses a missing signature", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-release-feed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const v = "0.1.0";
  for (const name of [
    `Portcove_${v}_x64-setup.exe`,
    `Portcove_${v}_amd64.AppImage`,
    `Portcove_${v}_universal.app.tar.gz`,
  ]) {
    await writeFile(path.join(dir, name), "payload");
    await writeFile(path.join(dir, `${name}.sig`), `sig-of-${name}\n`);
  }
  const base = "https://github.com/boburning/portcove/releases/download/v0.1.0";
  const feed = buildFeed({
    version: v,
    notes: "n",
    pubDate: "2026-11-13T00:00:00Z",
    assetsDir: dir,
    downloadBase: base,
  });
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "windows-x86_64",
  ]);
  assert.deepEqual(feed.platforms["windows-x86_64"], {
    signature: `sig-of-Portcove_${v}_x64-setup.exe`,
    url: `${base}/Portcove_${v}_x64-setup.exe`,
  });
  assert.equal(feed.platforms["darwin-x86_64"]!.url, feed.platforms["darwin-aarch64"]!.url);
  await rm(path.join(dir, `Portcove_${v}_amd64.AppImage.sig`));
  assert.throws(
    () => buildFeed({ version: v, notes: "n", pubDate: "x", assetsDir: dir, downloadBase: base }),
    /missing signed updater asset Portcove_0\.1\.0_amd64\.AppImage/u,
  );
});
