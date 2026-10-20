import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { readFile, readdir, rm, writeFile, link } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { trustedAssemblyFixture as fixture } from "./fixtures/trusted-assembly-fixture.mts";
import { assembleTrustedRelease } from "./trusted-release-assembly.mts";
import { artifactName, loadPackagePolicy } from "./release-package-policy.mts";

const policy = await loadPackagePolicy();
const version = "0.1.0-alpha.3";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

void test("named beta assembles all six Windows/Linux distributions and refuses missing, extra or unbound profile inputs", async (t) => {
  const f = await fixture(t, "initial-beta-win-linux");
  const assembled = await assembleTrustedRelease(f.root, f.input, f.request);
  assert.equal(assembled.output_files.length, 7);
  const inventory: unknown = JSON.parse(await readFile(assembled.inventory.path, "utf8"));
  assert.ok(
    inventory &&
      typeof inventory === "object" &&
      "packages" in inventory &&
      Array.isArray(inventory.packages),
  );
  assert.equal(inventory.packages.length, 6);
  for (const request of [
    { ...f.request, files: f.request.files.slice(1) },
    { ...f.request, release_profile: "full" },
    { ...f.request, release_profile: "unknown" },
    {
      ...f.request,
      files: [...f.request.files, { ...f.request.files[0], platform_label: "macos-aarch64" }],
    },
  ])
    await assert.rejects(assembleTrustedRelease(f.root, f.input, request));
});

void test("trusted assembly produces a complete new aggregate and exact inventory without authenticating declared producers", async (t) => {
  const f = await fixture(t);
  const first = await assembleTrustedRelease(f.root, f.input, f.request);
  assert.equal(first.role, "package-aggregate-assembler");
  assert.equal(first.release_authorization, "not-evaluated");
  assert.equal(first.sbom_finalization, "not-evaluated");
  assert.equal(first.authenticated_assembler, null);
  assert.equal(first.original_compiler, null);
  const names = policy.packages
    .map((entry) => artifactName(entry, version))
    .concat("SHA256SUMS.txt")
    .sort();
  assert.deepEqual((await readdir(first.assets)).sort(), names);
  assert.deepEqual(first.output_files.map((entry) => entry.filename).sort(), names);
  for (const entry of policy.packages) {
    const name = artifactName(entry, version);
    const expected = f.contents.get(`${entry.platform_label}/${name}`)!;
    const copied = await readFile(path.join(first.assets, name));
    assert.deepEqual(copied, expected);
    assert.deepEqual(
      first.output_files.find((item) => item.filename === name),
      { filename: name, bytes: expected.length, sha256: hash(expected) },
    );
  }
  const inventoryBytes = await readFile(first.inventory.path);
  assert.equal(hash(inventoryBytes), first.inventory.sha256);
  assert.equal(inventoryBytes.length, first.inventory.bytes);
  const manifest = await readFile(path.join(first.assets, "SHA256SUMS.txt"), "utf8");
  assert.equal(manifest.trim().split("\n").length, policy.packages.length);
  // A repeat creates a distinct owned result and preserves all earlier bytes.
  await writeFile(path.join(first.directory, "retained-failure-evidence.txt"), "keep");
  const second = await assembleTrustedRelease(f.root, f.input, f.request);
  assert.notEqual(second.directory, first.directory);
  assert.deepEqual(second.output_files, first.output_files);
  assert.equal(
    await readFile(path.join(first.directory, "retained-failure-evidence.txt"), "utf8"),
    "keep",
  );
});

void test("trusted assembly requires the complete fixed matrix and bounded unique input identities before output creation", async (t) => {
  const f = await fixture(t);
  const invalid = [
    { ...f.request, files: f.request.files.slice(1) },
    { ...f.request, files: [...f.request.files, f.request.files[0]] },
    {
      ...f.request,
      files: f.request.files.map((file, index) =>
        index === 0 ? { ...file, filename: "../outside.zip" } : file,
      ),
    },
    { ...f.request, source_tree: "unknown" },
    { ...f.request, files: f.request.files.map((file) => ({ ...file, bytes: 512 * 1024 * 1024 })) },
    {
      ...f.request,
      files: f.request.files.map((file) =>
        file.filename.startsWith("SHA256SUMS-") ? { ...file, bytes: 65537 } : file,
      ),
    },
  ];
  for (const request of invalid) {
    await assert.rejects(assembleTrustedRelease(f.root, f.input, request));
    assert.deepEqual(await readdir(f.root), ["input"]);
  }
});

void test("assembly refuses changed bytes and hard-linked sources while retaining owned partial evidence", async (t) => {
  const f = await fixture(t);
  const first = f.request.files[0]!;
  const filename = path.join(f.input, `release-build-${first.platform_label}`, first.filename);
  await writeFile(filename, Buffer.alloc(first.bytes, 120));
  await assert.rejects(
    assembleTrustedRelease(f.root, f.input, f.request),
    /retain owned directory/u,
  );
  let partial = (await readdir(f.root)).filter((name) => name.startsWith("trusted-assembly-"));
  assert.equal(partial.length, 1);
  assert.deepEqual(
    await readdir(
      path.join(f.root, partial[0]!, "inputs", `release-build-${first.platform_label}`),
    ),
    [first.filename],
  );
  await writeFile(filename, f.contents.get(`${first.platform_label}/${first.filename}`)!);
  await link(filename, path.join(f.root, "unrelated-hardlink"));
  await assert.rejects(
    assembleTrustedRelease(f.root, f.input, f.request),
    /retain owned directory/u,
  );
  partial = (await readdir(f.root)).filter((name) => name.startsWith("trusted-assembly-"));
  assert.equal(partial.length, 2);
  assert.deepEqual(
    await readFile(path.join(f.root, "unrelated-hardlink")),
    f.contents.get(`${first.platform_label}/${first.filename}`),
  );
});

void test("a self-consistent changed staging package and checksum cannot replace accepted bytes", async (t) => {
  const f = await fixture(t);
  const packageEntry = policy.packages[0]!;
  const name = artifactName(packageEntry, version);
  const original = f.contents.get(`${packageEntry.platform_label}/${name}`)!;
  const changed = Buffer.alloc(original.length, 122);
  let tampered = false;
  const realReaddir = fs.readdir;
  const mocked = t.mock.method(fs, "readdir", async (...args: Parameters<typeof readdir>) => {
    const directory = String(args[0]);
    if (
      !tampered &&
      directory.endsWith(path.join("inputs", `release-build-${packageEntry.platform_label}`))
    ) {
      tampered = true;
      await writeFile(path.join(directory, name), changed);
      const manifest = path.join(directory, `SHA256SUMS-${packageEntry.platform_label}.txt`);
      await writeFile(
        manifest,
        (await readFile(manifest, "utf8")).replace(hash(original), hash(changed)),
      );
    }
    return realReaddir(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(assembleTrustedRelease(f.root, f.input, f.request), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /differs from accepted input bytes/u);
      return true;
    });
    assert.equal(tampered, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

void test(
  "POSIX FIFO input refuses without hanging before handle validation",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const first = f.request.files[0]!;
    const filename = path.join(f.input, `release-build-${first.platform_label}`, first.filename);
    await rm(filename);
    execFileSync("mkfifo", [filename], { timeout: 5000, stdio: "pipe" });
    const module = new URL("./trusted-release-assembly.mts", import.meta.url).href;
    const program = `import {assembleTrustedRelease} from ${JSON.stringify(module)}; import fs from "node:fs"; const x=JSON.parse(fs.readFileSync(0,"utf8")); try {await assembleTrustedRelease(x.root,x.input,x.request);process.exitCode=1;}catch(error){if(!error.cause?.message.includes("regular unlinked"))throw error;}`;
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      input: JSON.stringify(f),
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  },
);
