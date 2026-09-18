import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareRustSupportArtifact,
  rustSupportCacheContract,
  rustSupportCompilerIdentity,
} from "./rust-support-cache.mjs";

const compiler = (name = "one", environment = []) => ({
  verbose_version: `rustc ${name}`,
  sysroot: `sysroot-${name}`,
  environment,
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-support-"));
  const source = path.join(root, "support.rs.txt");
  const target = path.join(root, "target");
  await writeFile(source, "fn main() {}\n");
  return {
    root,
    source,
    target,
    environment: { CARGO_TARGET_DIR: target, PATH: "fixture-path" },
  };
}

function compilerRun(events, contents = "compiled") {
  return (_command, args) => {
    events.push([...args]);
    const output = args.at(-1);
    writeFileSync(output, `${contents}:${args.join("|")}\n`);
    return { status: 0 };
  };
}

function prepare(state, overrides = {}) {
  return prepareRustSupportArtifact({
    root: state.root,
    product: "host-tool-probe",
    source: state.source,
    output: path.join(state.root, overrides.outputName ?? "fresh-probe.exe"),
    rustcArgs: ["--crate-name", "portcove_host_tool_fixture"],
    compiler: compiler(),
    environment: state.environment,
    platform: "win32",
    architecture: "x64",
    runSync: overrides.runSync,
    ...overrides,
  });
}

test("cold build publishes once and warm hits copy verified bytes into fresh fixtures", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events = [];
  const first = prepare(state, { runSync: compilerRun(events), outputName: "first.exe" });
  assert.equal(first.outcome, "built");
  assert.equal(first.reason, "missing-cache-entry");
  assert.equal(events.length, 1);

  writeFileSync(path.join(state.root, "first.exe"), "mutated fresh fixture\n");
  const second = prepare(state, { runSync: compilerRun(events), outputName: "second.exe" });
  assert.equal(second.outcome, "hit");
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(events.length, 1);
  assert.match(String(await readFile(path.join(state.root, "second.exe"))), /^compiled:/u);
  assert.doesNotMatch(String(await readFile(path.join(state.root, "second.exe"))), /mutated/u);
});

test("source, flags, compiler, target, and relevant environment identities invalidate reuse", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events = [];
  const runSync = compilerRun(events);
  const first = prepare(state, { runSync });
  await writeFile(state.source, 'fn main() { println!("changed"); }\n');
  const changedSource = prepare(state, { runSync, outputName: "source.exe" });
  const changedFlags = prepare(state, {
    runSync,
    outputName: "flags.exe",
    rustcArgs: ["--edition=2024", "--crate-name", "portcove_host_tool_fixture"],
  });
  const changedCompiler = prepare(state, {
    runSync,
    outputName: "compiler.exe",
    compiler: compiler("two"),
  });
  const changedTarget = prepare(state, {
    runSync,
    outputName: "target.exe",
    platform: "linux",
    architecture: "arm64",
  });
  const changedEnvironment = prepare(state, {
    runSync,
    outputName: "environment.exe",
    compiler: compiler("one", [{ name: "RUSTFLAGS", value_sha256: "a".repeat(64) }]),
  });
  assert.equal(events.length, 6);
  assert.equal(
    new Set([
      first.fingerprint,
      changedSource.fingerprint,
      changedFlags.fingerprint,
      changedCompiler.fingerprint,
      changedTarget.fingerprint,
      changedEnvironment.fingerprint,
    ]).size,
    6,
  );
});

test("corrupt cached output is quarantined, rebuilt, and never copied", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events = [];
  const runSync = compilerRun(events);
  const first = prepare(state, { runSync });
  const entry = path.join(
    state.target,
    "portcove-rust-support",
    "v1",
    "host-tool-probe",
    first.fingerprint,
  );
  writeFileSync(path.join(entry, "artifact"), "corrupt\n");
  const rebuilt = prepare(state, { runSync, outputName: "rebuilt.exe" });
  assert.equal(rebuilt.outcome, "built");
  assert.equal(rebuilt.reason, "cached-output-changed");
  assert.equal(events.length, 2);
  assert.ok(!readdirSync(path.dirname(entry)).some((name) => name.includes(".rejected-")));
});

test("tampered manifest identity is rejected and rebuilt", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events = [];
  const runSync = compilerRun(events);
  const first = prepare(state, { runSync });
  const manifestPath = path.join(
    state.target,
    "portcove-rust-support",
    "v1",
    "host-tool-probe",
    first.fingerprint,
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.input.source.sha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const rebuilt = prepare(state, { runSync, outputName: "rebuilt-manifest.exe" });
  assert.equal(rebuilt.outcome, "built");
  assert.equal(rebuilt.reason, "invalid-cache-manifest");
  assert.equal(events.length, 2);
});

test("linked cache ownership paths fail closed before compilation", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(os.tmpdir(), "portcove-rust-support-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  mkdirSync(state.target, { recursive: true });
  await symlink(
    outside,
    path.join(state.target, "portcove-rust-support"),
    process.platform === "win32" ? "junction" : "dir",
  );
  let compiled = false;
  assert.throws(
    () =>
      prepare(state, {
        runSync: () => {
          compiled = true;
          return { status: 0 };
        },
      }),
    /not an owned directory/u,
  );
  assert.equal(compiled, false);
});

test("interrupted candidates are never reused and stale candidates are removed after publication", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const productRoot = path.join(state.target, "portcove-rust-support", "v1", "host-tool-probe");
  const interrupted = path.join(productRoot, `${"f".repeat(64)}.candidate-deadbeef`);
  mkdirSync(interrupted, { recursive: true });
  writeFileSync(path.join(interrupted, "artifact"), "untrusted interrupted bytes\n");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(interrupted, old, old);

  const events = [];
  const built = prepare(state, { runSync: compilerRun(events), outputName: "fresh.exe" });
  assert.equal(built.outcome, "built");
  assert.equal(events.length, 1);
  assert.equal(existsSync(interrupted), false);
});

test("failed compilation publishes no reusable entry", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  assert.throws(
    () => prepare(state, { runSync: () => ({ status: 1 }) }),
    /support product compilation failed/u,
  );
  const productRoot = path.join(state.target, "portcove-rust-support", "v1", "host-tool-probe");
  assert.deepEqual(readdirSync(productRoot), []);
});

test("retention keeps only the newest bounded set of immutable identities", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events = [];
  for (let index = 0; index < rustSupportCacheContract.retainedEntriesPerProduct + 3; index += 1) {
    await writeFile(state.source, `fn main() { println!("${index}"); }\n`);
    prepare(state, { runSync: compilerRun(events), outputName: `probe-${index}.exe` });
  }
  const productRoot = path.join(state.target, "portcove-rust-support", "v1", "host-tool-probe");
  assert.equal(
    readdirSync(productRoot).filter((name) => /^[a-f0-9]{64}$/u.test(name)).length,
    rustSupportCacheContract.retainedEntriesPerProduct,
  );
});

test("compiler identity binds verbose version, sysroot, and hashed compile environment", () => {
  const probes = [];
  const identity = rustSupportCompilerIdentity({
    environment: {
      PATH: "one",
      RUSTFLAGS: "-C target-cpu=native",
      PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "must-not-enter-identity",
    },
    runSync: (_command, args) => {
      probes.push(args);
      return {
        status: 0,
        stdout: args.includes("sysroot") ? "C:/rust/sysroot\n" : "rustc 1.98.1\nhost: test\n",
      };
    },
  });
  assert.deepEqual(probes, [
    ["--version", "--verbose"],
    ["--print", "sysroot"],
  ]);
  assert.equal(identity.verbose_version, "rustc 1.98.1\nhost: test");
  assert.equal(identity.sysroot, "C:/rust/sysroot");
  assert.deepEqual(identity.commands, [
    { command: "rustc", resolved: null },
    { command: "link", resolved: null },
  ]);
  assert.deepEqual(
    identity.environment.map(({ name }) => name),
    ["RUSTFLAGS"],
  );
  assert.ok(identity.environment.every(({ value_sha256 }) => /^[a-f0-9]{64}$/u.test(value_sha256)));
});
