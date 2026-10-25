import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectNativeDependencyWorkspace,
  inspectNativePnpmArchive,
  inspectNativePnpmTar,
  nativePnpmVersion,
} from "./release-pnpm-runtime.mts";

function header(name: string, size: number, type = "0") {
  const h = Buffer.alloc(512);
  h.write(name);
  h.write("0000755\0", 100);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  const sum = h.reduce((n, b) => n + b, 0);
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
function tar(extra?: Buffer, windows = false) {
  const image = Buffer.alloc(128);
  image.write("MZ");
  image.writeUInt32LE(64, 60);
  image.write("PE\0\0", 64);
  image.writeUInt16LE(0x8664, 68);
  image.writeUInt16LE(0x20b, 88);
  const parts: Buffer[] = [];
  for (const [name, bytes] of [
    ["package/LICENSE", Buffer.from("license")],
    [
      windows ? "package/pnpm.exe" : "package/pnpm",
      windows ? image : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    ],
    [
      "package/package.json",
      Buffer.from(
        JSON.stringify({
          name: windows ? "@pnpm/exe.win32-x64" : "@pnpm/exe.linux-x64",
          version: nativePnpmVersion,
        }),
      ),
    ],
    ["package/THIRD-PARTY-NOTICES.md", Buffer.from("notices")],
  ] as const)
    parts.push(header(name, bytes.length), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  return Buffer.concat([...parts, ...(extra ? [extra] : []), Buffer.alloc(1024)]);
}
void test("fixed raw four-file package yields only the ELF and retained notices", () => {
  const p = inspectNativePnpmTar(tar());
  assert.equal(p.binary.toString("hex"), "7f454c46");
  assert.equal(p.license.toString(), "license");
  assert.equal(p.notices.toString(), "notices");
});
void test("Windows pin admits only its bounded four-file x64 PE package and refuses platform mixing", () => {
  const raw = tar(undefined, true);
  assert.equal(inspectNativePnpmTar(raw, "windows-x86_64").binary.readUInt16LE(68), 0x8664);
  assert.throws(() => inspectNativePnpmTar(raw));
  assert.throws(() => inspectNativePnpmTar(tar(), "windows-x86_64"));
  assert.throws(
    () => inspectNativePnpmArchive(Buffer.from("changed Windows archive"), "windows-x86_64"),
    /pinned pnpm archive differs/u,
  );
  const changed = Buffer.from(raw);
  // LICENSE occupies the first header/padded payload; pnpm's payload starts at1536.
  changed.writeUInt32LE(0xffffffff, 1536 + 60);
  assert.throws(() => inspectNativePnpmTar(changed, "windows-x86_64"), /PE header exceeds bound/u);
});
void test("raw extensions, oversized/truncated content, extras and checksum corruption refuse", () => {
  for (const raw of [
    Buffer.concat([header("package/pnpm", 2 ** 30, "x"), Buffer.alloc(1024)]),
    Buffer.concat([header("package/pnpm", 2 ** 30), Buffer.alloc(1024)]),
    tar(header("package/extra", 0)),
    tar(header("package/pnpm", 0)),
    tar().subarray(0, 1024),
  ])
    assert.throws(() => inspectNativePnpmTar(raw));
  const changed = tar();
  changed[0] = 0;
  assert.throws(() => inspectNativePnpmTar(changed));
  assert.throws(
    () => inspectNativePnpmArchive(Buffer.from("untrusted bytes")),
    /pinned pnpm archive differs/u,
  );
});
void test("workspace settings are parsed semantically and restrict executable and storage extensions", () => {
  const baseline =
    "packages: [apps/desktop]\nstoreDir: work/pnpm-store\nruntimeOnFail: ignore\npmOnFail: ignore\npatchedDependencies: {pkg: patches/pkg.patch}\n";
  assert.deepEqual(inspectNativeDependencyWorkspace(Buffer.from(baseline)).patches, [
    "patches/pkg.patch",
  ]);
  for (const extra of [
    '"configDependencies": {pkg: 1}',
    "modulesDir: /outside",
    '"virtualStoreDir": /outside',
    "runtimeOnFail: download",
    "packages: [../outside]",
    "patchedDependencies: {pkg: ../outside}",
    "catalog: {pkg: 'file:/outside'}",
    "peerDependencyRules: {unknown: true}",
  ])
    assert.throws(() =>
      inspectNativeDependencyWorkspace(Buffer.from(`packages: [apps/desktop]\n${extra}\n`)),
    );
  assert.throws(() =>
    inspectNativeDependencyWorkspace(
      Buffer.from('{packages: [apps/desktop], "configDependencies": {pkg: 1}}'),
    ),
  );
  assert.throws(() =>
    inspectNativeDependencyWorkspace(Buffer.from("packages: &a [apps/desktop]\ncatalog: *a")),
  );
});
