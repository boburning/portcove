import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, linkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readWindowsFixtureStreamPrefix } from "./qualify-controller-tools-windows.mts";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import {
  inspectWindowsNativeDependencyInputs,
  inspectWindowsNativeDependencyTarget,
  snapshotWindowsNativeDependencies,
} from "./release-hosted-native-windows-dependency-files.mts";

const deadline = () => performance.now() + 10000;
const active = () => {};
function fixture(context: test.TestContext) {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-win-dependencies-"));
  for (const name of ["node_modules", "apps/desktop/node_modules"])
    mkdirSync(path.join(root, name), { recursive: true });
  return root;
}
function link(target: string, filename: string) {
  symlinkSync(
    process.platform === "win32" ? target : path.relative(path.dirname(filename), target),
    filename,
    process.platform === "win32" ? "junction" : "dir",
  );
}

void test("Windows dependency target syntax supports local junctions without UNC/device/ADS ambiguity", () => {
  assert.equal(
    inspectWindowsNativeDependencyTarget("\\\\?\\C:\\source\\node_modules\\pkg"),
    "C:\\source\\node_modules\\pkg",
  );
  assert.equal(inspectWindowsNativeDependencyTarget("../.pnpm/pkg"), "..\\.pnpm\\pkg");
  for (const invalid of [
    "\\\\server\\share",
    "\\\\?\\UNC\\server\\share",
    "\\\\.\\device",
    "\\??\\C:\\other",
    "C:relative",
    "C:\\file:stream",
    "relative:stream",
    "\\rooted",
    "bad\0name",
  ])
    assert.throws(() => inspectWindowsNativeDependencyTarget(invalid));
});

void test("Windows dependency snapshots hash physical files once and preserve ordinary package cycles", async (context) => {
  const root = fixture(context),
    a = path.join(root, "node_modules/.pnpm/a/node_modules/a"),
    b = path.join(root, "node_modules/.pnpm/b/node_modules/b");
  for (const dir of [a, b]) {
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "index.js"), "export {};\n", { mode: 0o600 });
  }
  link(b, path.join(a, "node_modules/b"));
  link(a, path.join(b, "node_modules/a"));
  link(a, path.join(root, "node_modules/a"));
  const observed = await snapshotWindowsNativeDependencies(root, deadline(), active),
    again = await snapshotWindowsNativeDependencies(root, deadline(), active);
  assert.equal(observed.sha256, again.sha256);
  assert.equal(observed.records.filter((row) => row.kind === "file").length, 2);
  assert.equal(observed.records.filter((row) => row.kind === "link").length, 3);
  assert.equal(observed.authority, "none");
  writeFileSync(path.join(a, "index.js"), "changed\n", { mode: 0o600 });
  assert.notEqual(
    (await snapshotWindowsNativeDependencies(root, deadline(), active)).sha256,
    observed.sha256,
  );
});

void test("Windows dependency snapshots refuse external aliases and source-root links", async (context) => {
  const root = fixture(context),
    outside = fixture(context);
  writeFileSync(path.join(outside, "keep"), "retained", { mode: 0o600 });
  link(outside, path.join(root, "node_modules/external"));
  await assert.rejects(snapshotWindowsNativeDependencies(root, deadline(), active), /escapes/);
  assert.equal(readFileSync(path.join(outside, "keep"), "utf8"), "retained");
  const other = fixture(context);
  link(other, path.join(other, "node_modules/root"));
  await assert.rejects(snapshotWindowsNativeDependencies(other, deadline(), active), /source root/);
});

void test("Windows dependency snapshots hash pnpm's fixed workspace including untracked nested leaves", async (context) => {
  const root = fixture(context),
    workspace = path.join(root, "apps", "desktop"),
    modules = path.join(root, "node_modules", ".pnpm", "node_modules");
  mkdirSync(modules, { recursive: true });
  writeFileSync(path.join(workspace, "package.json"), '{"name":"portcove-desktop-ui"}\n');
  link(workspace, path.join(modules, "portcove-desktop-ui"));
  const graph = await snapshotWindowsNativeDependencies(root, deadline(), active);
  assert.ok(
    graph.records.some(
      (row) => row.path === path.join("apps", "desktop") && row.kind === "directory",
    ),
  );
  assert.ok(
    graph.records.some(
      (row) => row.kind === "link" && row.resolved === path.join("apps", "desktop"),
    ),
  );
  assert.ok(
    graph.records.some(
      (row) => row.path === path.join("apps", "desktop", "package.json") && row.kind === "file",
    ),
  );
  const cache = path.join(workspace, "cache");
  mkdirSync(cache);
  const extra = path.join(cache, "extra.js");
  writeFileSync(extra, "before");
  const before = await snapshotWindowsNativeDependencies(root, deadline(), active);
  const workspaceBefore = statSync(workspace, { bigint: true });
  writeFileSync(extra, "change");
  const workspaceAfter = statSync(workspace, { bigint: true });
  assert.equal(workspaceBefore.mtimeNs, workspaceAfter.mtimeNs);
  assert.equal(workspaceBefore.ctimeNs, workspaceAfter.ctimeNs);
  assert.notEqual(
    (await snapshotWindowsNativeDependencies(root, deadline(), active)).sha256,
    before.sha256,
  );
});

void test("Windows dependency snapshots refuse contained targets outside the inventoried graph", async (context) => {
  const root = fixture(context),
    target = path.join(root, "untracked-cache/pkg");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "index.js"), "untracked", { mode: 0o600 });
  link(target, path.join(root, "node_modules/pkg"));
  await assert.rejects(
    snapshotWindowsNativeDependencies(root, deadline(), active),
    /outside inventoried physical graph/,
  );
  assert.equal(readFileSync(path.join(target, "index.js"), "utf8"), "untracked");
});

void test("Windows dependency snapshots refuse hardlinked files and expired original clocks", async (context) => {
  const root = fixture(context),
    file = path.join(root, "node_modules/data");
  writeFileSync(file, "same", { mode: 0o600 });
  linkSync(file, path.join(root, "node_modules/alias"));
  await assert.rejects(snapshotWindowsNativeDependencies(root, deadline(), active));
  await assert.rejects(
    snapshotWindowsNativeDependencies(root, performance.now() - 1, active),
    /deadline exhausted/,
  );
});

void test("Windows dependency snapshots reject cyclic link resolution without traversing it", async (context) => {
  const root = fixture(context),
    first = path.join(root, "node_modules/first"),
    second = path.join(root, "node_modules/second");
  link(second, first);
  link(first, second);
  await assert.rejects(snapshotWindowsNativeDependencies(root, deadline(), active), /cycle/);
});

void test("Windows dependency preflight rejects lockfile routes as well as manifest and registry overrides", async (context) => {
  const root = fixture(context);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@12.16.1", dependencies: { inert: "1.0.0" } }),
    { mode: 0o600 },
  );
  writeFileSync(path.join(root, "apps/desktop/package.json"), "{}", { mode: 0o600 });
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: [apps/desktop]\n", {
    mode: 0o600,
  });
  const lock = `lockfileVersion: '9.0'\npackages:\n  inert@1.0.0:\n    resolution: {integrity: sha512-${Buffer.alloc(64).toString("base64")}}\nimporters:\n  .: {}\n`;
  writeFileSync(path.join(root, "pnpm-lock.yaml"), lock, { mode: 0o600 });
  assert.equal(
    (await inspectWindowsNativeDependencyInputs(root, deadline(), active)).registry_packages,
    1,
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), lock + "---\n" + lock, { mode: 0o600 });
  assert.equal(
    (await inspectWindowsNativeDependencyInputs(root, deadline(), active)).registry_packages,
    2,
  );
  writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    lock +
      "---\n" +
      lock.replace(
        "resolution: {",
        "resolution: {tarball: 'https://outside.invalid/package.tgz', ",
      ),
    { mode: 0o600 },
  );
  await assert.rejects(
    inspectWindowsNativeDependencyInputs(root, deadline(), active),
    /lock resolution refused/,
  );
  writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    lock.replace("resolution: {", "resolution: {tarball: 'https://outside.invalid/package.tgz', "),
    { mode: 0o600 },
  );
  await assert.rejects(
    inspectWindowsNativeDependencyInputs(root, deadline(), active),
    /lock resolution refused/,
  );
  writeFileSync(path.join(root, "pnpm-lock.yaml"), lock, { mode: 0o600 });
  writeFileSync(path.join(root, ".npmrc"), "registry=https://outside.invalid\n", { mode: 0o600 });
  await assert.rejects(
    inspectWindowsNativeDependencyInputs(root, deadline(), active),
    /registry overrides refused/,
  );
});

void test("Windows dependency preflight accepts the maintained registry-only multi-document repository lock", async () => {
  const observed = await inspectWindowsNativeDependencyInputs(
    path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    deadline(),
    active,
  );
  assert.ok(observed.registry_packages > 0);
  assert.match(observed.lock_sha256, /^[a-f0-9]{64}$/u);
});

void test("Windows fixture diagnostics retain oversized binary prefixes and refuse linked streams", async (context) => {
  const root = fixture(context),
    bytes = Buffer.alloc(100000, 255),
    name = "capture.bin";
  writeFileSync(path.join(root, name), bytes, { mode: 0o600 });
  const observed = await readWindowsFixtureStreamPrefix(root, name);
  assert.equal(observed.observed_bytes, bytes.length);
  assert.equal(observed.retained_bytes, 16384);
  assert.equal(observed.truncated, true);
  assert.deepEqual(Buffer.from(observed.base64, "base64"), bytes.subarray(0, 16384));
  assert.equal(
    observed.sha256,
    createHash("sha256").update(bytes.subarray(0, 16384)).digest("hex"),
  );
  writeFileSync(path.join(root, "empty"), "", { mode: 0o600 });
  assert.equal((await readWindowsFixtureStreamPrefix(root, "empty")).retained_bytes, 0);
  linkSync(path.join(root, name), path.join(root, "alias"));
  await assert.rejects(readWindowsFixtureStreamPrefix(root, name));
});

void test("Windows graph hashing refuses ancestor and source-root replacement even when the opened inode is unchanged", (context) => {
  const root = disposableDirectory(context, path.join(tmpdir(), "pc-win-hash-drift-")),
    module = new URL("./release-hosted-native-windows-dependency-files.mts", import.meta.url).href;
  const code = String.raw`
import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import * as fs from 'node:fs';import * as fsp from 'node:fs/promises';import path from 'node:path';
const scratch=process.argv[1];let source,target,relocate,replacement,changed=false;
globalThis.graphFs={opendir:fsp.opendir,open:async(...args)=>{if(args[0]===target&&!changed){changed=true;fs.renameSync(relocate,replacement);fs.symlinkSync(replacement,relocate,process.platform==='win32'?'junction':'dir')}return fsp.open(...args)}};
registerHooks({resolve(s,c,next){if(c.parentURL===${JSON.stringify(module)}&&s==='node:fs/promises')return {url:'graph-fs:controlled',shortCircuit:true};return next(s,c)},load(u,c,next){if(u==='graph-fs:controlled')return {format:'module',source:'export const open=globalThis.graphFs.open;export const opendir=globalThis.graphFs.opendir;',shortCircuit:true};return next(u,c)}});
const {snapshotWindowsNativeDependencies}=await import(${JSON.stringify(module)});
for(const kind of ['ancestor','source-root']){
 source=path.join(scratch,kind);fs.mkdirSync(path.join(source,'node_modules/pkg'),{recursive:true});fs.mkdirSync(path.join(source,'apps/desktop/node_modules'),{recursive:true});target=path.join(source,'node_modules/pkg/index.js');fs.writeFileSync(target,Buffer.alloc(128000,65),{mode:0o600});
 relocate=kind==='ancestor'?path.dirname(target):source;replacement=path.join(scratch,'retained-'+kind);changed=false;
 await assert.rejects(snapshotWindowsNativeDependencies(source,performance.now()+10000,()=>{}),/changed/);assert.equal(changed,true);assert.equal(fs.readFileSync(kind==='ancestor'?path.join(replacement,'index.js'):path.join(replacement,'node_modules/pkg/index.js')).length,128000);
}
console.log('controlled ancestor replacements refused; no native or account acceptance');
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, root], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ancestor replacements refused/u);
});
