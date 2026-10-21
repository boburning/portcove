import type {
  CompilerIdentity,
  CompilerRunner,
  RustSupportOptions,
} from "./rust-support-cache.mts";
import { isRecord } from "./runtime-values.mts";
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function lastArg(args: readonly string[]): string {
  const value = args.at(-1);
  assert.ok(value);
  return value;
}
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareRustSupportArtifact,
  rustSupportCacheContract,
  rustSupportCompilerIdentity,
} from "./rust-support-cache.mts";

const compiler = (
  name = "one",
  environment: CompilerIdentity["environment"] = [],
): CompilerIdentity => ({
  verbose_version: `rustc ${name}`,
  sysroot: `sysroot-${name}`,
  environment,
  commands: [],
});

async function fixture() {
  // Normalize OS temporary-directory aliases (such as macOS /tmp) at the owned
  // fixture boundary; configured cache paths still reject linked ancestors.
  const root = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), "portcove-rust-support-")));
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

function compilerRun(events: string[][], contents = "compiled"): CompilerRunner {
  return (_command, args) => {
    events.push([...args]);
    const output = lastArg(args);
    writeFileSync(output, `${contents}:${args.join("|")}\n`);
    return { status: 0 };
  };
}

function prepare(
  state: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Omit<RustSupportOptions, "runSync">> & {
    runSync: CompilerRunner;
    outputName?: string;
  },
) {
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
    ...overrides,
  });
}

void test("support-first cold and warm preparation leave Cargo's target absent and copy verified bytes", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events: string[][] = [];
  const first = prepare(state, { runSync: compilerRun(events), outputName: "first.exe" });
  assert.equal(first.outcome, "built");
  assert.equal(first.reason, "missing-cache-entry");
  assert.equal(events.length, 1);
  assert.equal(existsSync(state.target), false);
  assert.equal(existsSync(`${state.target}.portcove-rust-support`), true);

  writeFileSync(path.join(state.root, "first.exe"), "mutated fresh fixture\n");
  const second = prepare(state, { runSync: compilerRun(events), outputName: "second.exe" });
  assert.equal(second.outcome, "hit");
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(events.length, 1);
  assert.equal(existsSync(state.target), false);
  assert.match(String(await readFile(path.join(state.root, "second.exe"))), /^compiled:/u);
  assert.doesNotMatch(String(await readFile(path.join(state.root, "second.exe"))), /mutated/u);
});

void test("Cargo-first preparation preserves the existing target, marker, and unrelated contents", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  mkdirSync(path.join(state.target, "debug"), { recursive: true });
  // This is only a preservation canary. The real Cargo smoke establishes that
  // Cargo creates its own valid marker; preparation must never create one.
  const marker = "Cargo-first marker preservation fixture\n";
  await writeFile(path.join(state.target, "CACHEDIR.TAG"), marker);
  await writeFile(path.join(state.target, "debug", "keep.txt"), "unrelated target output\n");
  const events: string[][] = [];
  const first = prepare(state, { runSync: compilerRun(events) });
  const second = prepare(state, { runSync: compilerRun(events), outputName: "second.exe" });

  assert.equal(first.outcome, "built");
  assert.equal(second.outcome, "hit");
  assert.equal(events.length, 1);
  assert.deepEqual(readdirSync(state.target).sort(), ["CACHEDIR.TAG", "debug"]);
  assert.deepEqual(readdirSync(path.join(state.target, "debug")), ["keep.txt"]);
  assert.equal(await readFile(path.join(state.target, "CACHEDIR.TAG"), "utf8"), marker);
  assert.equal(
    await readFile(path.join(state.target, "debug", "keep.txt"), "utf8"),
    "unrelated target output\n",
  );
});

void test("default, relative, and absolute Cargo targets use independent adjacent support caches", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const externalRoot = realpathSync.native(
    await mkdtemp(path.join(os.tmpdir(), "portcove-rust-support-selected-")),
  );
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const selections = [
    { name: "default", configured: undefined, target: state.target },
    {
      name: "relative",
      configured: path.join("build caches", "selected target"),
      target: path.join(state.root, "build caches", "selected target"),
    },
    {
      name: "absolute",
      configured: path.join(externalRoot, "selected target"),
      target: path.join(externalRoot, "selected target"),
    },
  ];
  const events: string[][] = [];
  const fingerprints = new Set<string>();
  for (const selection of selections) {
    const environment = { PATH: "fixture-path", CARGO_TARGET_DIR: selection.configured };
    const built = prepare(state, {
      environment,
      runSync: compilerRun(events),
      outputName: `${selection.name}.exe`,
    });
    assert.equal(built.outcome, "built");
    fingerprints.add(built.fingerprint);
    assert.equal(existsSync(selection.target), false);
    assert.equal(
      existsSync(
        path.join(
          `${selection.target}.portcove-rust-support`,
          "v1",
          "host-tool-probe",
          built.fingerprint,
          "artifact",
        ),
      ),
      true,
    );
    assert.equal(
      prepare(state, {
        environment,
        runSync: compilerRun(events),
        outputName: `${selection.name}-warm.exe`,
      }).outcome,
      "hit",
    );
    assert.equal(existsSync(selection.target), false);
  }
  assert.equal(events.length, selections.length);
  assert.equal(fingerprints.size, 1);
});

void test("valid legacy caches remain untouched and unused inside an untagged Cargo target", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events: string[][] = [];
  const initial = prepare(state, { runSync: compilerRun(events, "legacy") });
  mkdirSync(state.target);
  const legacyRoot = path.join(state.target, "portcove-rust-support");
  // Seed a valid old-format cache using only this test's disposable artifacts.
  await rename(`${state.target}.portcove-rust-support`, legacyRoot);
  const legacyEntry = path.join(legacyRoot, "v1", "host-tool-probe", initial.fingerprint);
  const legacyArtifact = await readFile(path.join(legacyEntry, "artifact"));
  const legacyManifest = await readFile(path.join(legacyEntry, "manifest.json"));
  await writeFile(path.join(state.target, "keep.txt"), "unknown target sentinel\n");

  const rebuilt = prepare(state, {
    runSync: compilerRun(events, "fresh"),
    outputName: "fresh.exe",
  });
  assert.equal(rebuilt.outcome, "built");
  assert.equal(rebuilt.reason, "missing-cache-entry");
  assert.equal(rebuilt.fingerprint, initial.fingerprint);
  assert.equal(events.length, 2);
  assert.match(await readFile(path.join(state.root, "fresh.exe"), "utf8"), /^fresh:/u);
  assert.deepEqual(await readFile(path.join(legacyEntry, "artifact")), legacyArtifact);
  assert.deepEqual(await readFile(path.join(legacyEntry, "manifest.json")), legacyManifest);
  assert.deepEqual(readdirSync(state.target).sort(), ["keep.txt", "portcove-rust-support"]);
  assert.equal(
    await readFile(path.join(state.target, "keep.txt"), "utf8"),
    "unknown target sentinel\n",
  );
  assert.equal(existsSync(path.join(state.target, "CACHEDIR.TAG")), false);
});

void test("a concurrent valid publisher wins without reusing or retaining the losing candidate", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const winnerEvents: string[][] = [];
  let nested = false;
  const result = prepare(state, {
    outputName: "outer.exe",
    runSync: (_command, args) => {
      assert.equal(nested, false);
      nested = true;
      const winner = prepare(state, {
        outputName: "winner.exe",
        runSync: compilerRun(winnerEvents, "winner"),
      });
      assert.equal(winner.outcome, "built");
      writeFileSync(lastArg(args), "losing concurrent bytes\n");
      return { status: 0 };
    },
  });
  assert.equal(result.outcome, "built");
  assert.equal(winnerEvents.length, 1);
  assert.match(String(await readFile(path.join(state.root, "outer.exe"))), /^winner:/u);
  const productRoot = path.join(`${state.target}.portcove-rust-support`, "v1", "host-tool-probe");
  assert.deepEqual(readdirSync(productRoot), [result.fingerprint]);
});

void test("source, flags, compiler, target, and relevant environment identities invalidate reuse", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events: string[][] = [];
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

void test("corrupt cached output is quarantined, rebuilt, and never copied", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events: string[][] = [];
  const runSync = compilerRun(events);
  const first = prepare(state, { runSync });
  const entry = path.join(
    `${state.target}.portcove-rust-support`,
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

void test("tampered manifest identity is rejected and rebuilt", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events: string[][] = [];
  const runSync = compilerRun(events);
  const first = prepare(state, { runSync });
  const manifestPath = path.join(
    `${state.target}.portcove-rust-support`,
    "v1",
    "host-tool-probe",
    first.fingerprint,
    "manifest.json",
  );
  const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")));
  record(record(manifest.input).source).sha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const rebuilt = prepare(state, { runSync, outputName: "rebuilt-manifest.exe" });
  assert.equal(rebuilt.outcome, "built");
  assert.equal(rebuilt.reason, "invalid-cache-manifest");
  assert.equal(events.length, 2);
});

void test("linked and non-directory cache paths fail before mkdir or compilation", async (t) => {
  for (const kind of ["link", "file"] as const) {
    for (const level of ["ancestor", "cache", "version", "product"] as const) {
      await t.test(`${kind} at ${level}`, async (t) => {
        const state = await fixture();
        t.after(() => rm(state.root, { recursive: true, force: true }));
        const outside = path.join(state.root, "outside");
        mkdirSync(outside);
        await writeFile(path.join(outside, "keep.txt"), "outside sentinel\n");
        const target =
          level === "ancestor"
            ? path.join(state.root, "ancestor", "missing", "target")
            : state.target;
        const unsafePath =
          level === "ancestor"
            ? path.join(state.root, "ancestor")
            : path.join(
                `${target}.portcove-rust-support`,
                ...(level === "cache" ? [] : ["v1"]),
                ...(level === "product" ? ["host-tool-probe"] : []),
              );
        mkdirSync(path.dirname(unsafePath), { recursive: true });
        if (kind === "link")
          await symlink(outside, unsafePath, process.platform === "win32" ? "junction" : "dir");
        else await writeFile(unsafePath, "not a directory\n");
        let compiled = false;
        assert.throws(
          () =>
            prepare(state, {
              environment: { ...state.environment, CARGO_TARGET_DIR: target },
              runSync: () => {
                compiled = true;
                return { status: 0 };
              },
            }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              `Rust support cache path is not an owned directory: ${unsafePath}`,
            );
            return true;
          },
        );
        assert.equal(compiled, false);
        assert.equal(existsSync(target), false);
        assert.deepEqual(readdirSync(outside), ["keep.txt"]);
        assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "outside sentinel\n");
        if (kind === "link") assert.equal(lstatSync(unsafePath).isSymbolicLink(), true);
        else assert.equal(await readFile(unsafePath, "utf8"), "not a directory\n");
      });
    }
  }
});

void test("interrupted candidates are never reused and stale candidates are removed after publication", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const productRoot = path.join(`${state.target}.portcove-rust-support`, "v1", "host-tool-probe");
  const interrupted = path.join(productRoot, `${"f".repeat(64)}.candidate-deadbeef`);
  mkdirSync(interrupted, { recursive: true });
  writeFileSync(path.join(interrupted, "artifact"), "untrusted interrupted bytes\n");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  await utimes(interrupted, old, old);

  const events: string[][] = [];
  const built = prepare(state, { runSync: compilerRun(events), outputName: "fresh.exe" });
  assert.equal(built.outcome, "built");
  assert.equal(events.length, 1);
  assert.equal(existsSync(interrupted), false);
});

void test("failed compilation publishes no reusable entry", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  assert.throws(
    () => prepare(state, { runSync: () => ({ status: 1 }) }),
    /support product compilation failed/u,
  );
  const productRoot = path.join(`${state.target}.portcove-rust-support`, "v1", "host-tool-probe");
  assert.deepEqual(readdirSync(productRoot), []);
});

void test("retention keeps only the newest bounded set of immutable identities", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const events: string[][] = [];
  for (let index = 0; index < rustSupportCacheContract.retainedEntriesPerProduct + 3; index += 1) {
    await writeFile(state.source, `fn main() { println!("${index}"); }\n`);
    prepare(state, { runSync: compilerRun(events), outputName: `probe-${index}.exe` });
  }
  const productRoot = path.join(`${state.target}.portcove-rust-support`, "v1", "host-tool-probe");
  assert.equal(
    readdirSync(productRoot).filter((name) => /^[a-f0-9]{64}$/u.test(name)).length,
    rustSupportCacheContract.retainedEntriesPerProduct,
  );
});

void test("compiler identity binds version, sysroot, platform linkers, and compile environment", () => {
  const probes: (readonly string[])[] = [];
  for (const [platform, commands] of [
    ["win32", ["rustc", "link"]],
    ["linux", ["rustc", "cc", "ld"]],
  ] as const) {
    const identity = rustSupportCompilerIdentity({
      environment: {
        PATH: "one",
        RUSTFLAGS: "-C target-cpu=native",
        PORTCOVE_HEAVY_RUST_LOCK_TOKEN: "must-not-enter-identity",
      },
      platform,
      runSync: (_command, args) => {
        probes.push(args);
        return {
          status: 0,
          stdout: args.includes("sysroot") ? "C:/rust/sysroot\n" : "rustc 1.98.1\nhost: test\n",
        };
      },
    });
    assert.equal(identity.verbose_version, "rustc 1.98.1\nhost: test");
    assert.equal(identity.sysroot, "C:/rust/sysroot");
    assert.deepEqual(
      identity.commands,
      commands.map((command) => ({ command, resolved: null })),
    );
    assert.deepEqual(
      identity.environment.map(({ name }) => name),
      ["RUSTFLAGS"],
    );
    assert.ok(
      identity.environment.every(({ value_sha256 }) => /^[a-f0-9]{64}$/u.test(value_sha256)),
    );
  }
  assert.deepEqual(probes, [
    ["--version", "--verbose"],
    ["--print", "sysroot"],
    ["--version", "--verbose"],
    ["--print", "sysroot"],
  ]);
});

void test("resolved compiler and linker bytes invalidate the reusable artifact identity", async (t) => {
  const state = await fixture();
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const tools = path.join(state.root, "tools");
  mkdirSync(tools);
  for (const command of ["rustc", "cc", "ld"])
    writeFileSync(path.join(tools, command), `${command} version one\n`);
  const environment = { PATH: tools };
  const identify = () =>
    rustSupportCompilerIdentity({
      environment,
      platform: "linux",
      runSync: (_command, args) => ({
        status: 0,
        stdout: args.includes("sysroot") ? "/fixture/sysroot\n" : "rustc fixture\nhost: test\n",
      }),
    });
  const events: string[][] = [];
  const firstCompiler = identify();
  const first = prepare(state, { compiler: firstCompiler, runSync: compilerRun(events) });

  writeFileSync(path.join(tools, "rustc"), "rustc version two\n");
  const changedCompilerIdentity = identify();
  const changedCompiler = prepare(state, {
    compiler: changedCompilerIdentity,
    outputName: "changed-compiler.exe",
    runSync: compilerRun(events),
  });

  writeFileSync(path.join(tools, "cc"), "cc version two\n");
  const changedLinkerIdentity = identify();
  const changedLinker = prepare(state, {
    compiler: changedLinkerIdentity,
    outputName: "changed-linker.exe",
    runSync: compilerRun(events),
  });

  assert.equal(events.length, 3);
  assert.equal(
    new Set([first.fingerprint, changedCompiler.fingerprint, changedLinker.fingerprint]).size,
    3,
  );
  assert.ok(firstCompiler.commands[0]);
  assert.ok(changedCompilerIdentity.commands[0]);
  assert.ok(changedCompilerIdentity.commands[1]);
  assert.ok(changedLinkerIdentity.commands[0]);
  assert.ok(changedLinkerIdentity.commands[1]);
  assert.notEqual(firstCompiler.commands[0].sha256, changedCompilerIdentity.commands[0].sha256);
  assert.equal(
    changedCompilerIdentity.commands[0].sha256,
    changedLinkerIdentity.commands[0].sha256,
  );
  assert.notEqual(
    changedCompilerIdentity.commands[1].sha256,
    changedLinkerIdentity.commands[1].sha256,
  );
  assert.ok(changedLinkerIdentity.commands.every(({ resolved }) => resolved !== null));
});

void test("existing cache entries with missing manifest or artifact are quarantined before publication", async (t) => {
  for (const missing of ["manifest.json", "artifact"]) {
    const state = await fixture();
    t.after(() => rm(state.root, { recursive: true, force: true }));
    const events: string[][] = [];
    const runSync = compilerRun(events);
    const initial = prepare(state, { runSync });
    const entry = path.join(
      `${state.target}.portcove-rust-support`,
      "v1",
      "host-tool-probe",
      initial.fingerprint,
    );
    await rm(path.join(entry, missing));
    const rebuilt = prepare(state, { runSync, outputName: `rebuilt-${missing}.exe` });
    assert.equal(rebuilt.outcome, "built");
    assert.equal(rebuilt.reason, "incomplete-cache-entry");
    assert.equal(events.length, 2);
    assert.equal(prepare(state, { runSync }).outcome, "hit");
    assert.equal(events.length, 2);
  }
});
