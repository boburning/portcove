import type { TestContext } from "node:test";
import type { PinnedAquaOptions } from "./tool-cache.mts";
import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cachedDesktopDrivers,
  checkoutToolEnvironment,
  readToolPins,
  readToolState,
  pinnedAquaCommand,
  toolCachePaths,
} from "./tool-cache.mts";

function aquaFixture(t: TestContext) {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const aqua: {
    artifacts: { "win32-x64": { sha256: string }; "win32-arm64"?: { sha256: string } };
  } = { artifacts: { "win32-x64": { sha256: "C".repeat(64) } } };
  item.paths.pins.bootstrap.aqua = aqua;
  mkdirSync(item.paths.shimDirectory, { recursive: true });
  const state = {
    format_version: 1,
    pin_fingerprint: item.paths.pins.fingerprint,
    shared_root: item.paths.sharedRoot,
    shim_directory: item.paths.shimDirectory,
    aqua_root: item.paths.aquaRoot,
    aqua: item.paths.aquaExecutable,
  };
  writeFileSync(item.paths.statePath, JSON.stringify(state));
  mkdirSync(path.dirname(item.paths.aquaExecutable), { recursive: true });
  const receipt = { version: item.paths.pins.aquaSemver, archive_sha256: "C".repeat(64) };
  writeFileSync(`${item.paths.aquaExecutable}.receipt.json`, JSON.stringify(receipt));
  return {
    ...item,
    paths: {
      ...item.paths,
      pins: { ...item.paths.pins, bootstrap: { ...item.paths.pins.bootstrap, aqua } },
    },
    state,
    receipt,
  };
}

void test("pinned Aqua ignores a conflicting PATH executable and preserves child-only environment", (t) => {
  const item = aquaFixture(t);
  const environment: NodeJS.ProcessEnv = { Path: "C:\\old-machine-tools", marker: "unchanged" };
  const calls: {
    command: string;
    args: readonly string[];
    options: Parameters<NonNullable<PinnedAquaOptions["probe"]>>[2];
  }[] = [];
  const executable = pinnedAquaCommand({
    paths: item.paths,
    platform: "win32",
    osArchitecture: "x64",
    environment,
    probe: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "aqua version 2.62.3\r\n" };
    },
  });
  assert.equal(executable, item.paths.aquaExecutable);
  assert.deepEqual(first(calls).args, ["--version"]);
  assert.equal(first(calls).command, executable);
  assert.equal(first(calls).options.cwd, item.paths.projectRoot);
  assert.equal(first(calls).options.env?.AQUA_ROOT_DIR, item.paths.aquaRoot);
  assert.equal(environment.Path, "C:\\old-machine-tools");
  assert.equal(environment.AQUA_ROOT_DIR, undefined);
});

void test("pinned Aqua fails closed on absent, stale or corrupt cache identities without PATH probing", (t) => {
  const item = aquaFixture(t);
  let probes = 0;
  const options = {
    paths: item.paths,
    platform: "win32",
    osArchitecture: "x64",
    probe: () => {
      probes++;
      return { status: 0, stdout: "aqua version 2.62.3" };
    },
  };
  for (const receipt of [
    null,
    "broken JSON",
    { ...item.receipt, version: "2.61.0" },
    { ...item.receipt, archive_sha256: "D".repeat(64) },
  ]) {
    if (receipt == null) rmSync(`${item.paths.aquaExecutable}.receipt.json`);
    else
      writeFileSync(
        `${item.paths.aquaExecutable}.receipt.json`,
        typeof receipt === "string" ? receipt : JSON.stringify(receipt),
      );
    assert.throws(() => pinnedAquaCommand(options), /cache receipt.*bootstrap-quality-tools/u);
  }
  writeFileSync(`${item.paths.aquaExecutable}.receipt.json`, JSON.stringify(item.receipt));
  writeFileSync(
    item.paths.statePath,
    JSON.stringify({ ...item.state, aqua: "C:\\stale\\aqua.exe" }),
  );
  assert.throws(() => pinnedAquaCommand(options), /checkout state.*bootstrap-quality-tools/u);
  rmSync(item.paths.statePath);
  assert.throws(() => pinnedAquaCommand(options), /checkout state/u);
  assert.equal(probes, 0);
});

void test("pinned Aqua rejects missing, failed or wrong-version payloads without stale PATH fallback", (t) => {
  const item = aquaFixture(t);
  const options = { paths: item.paths, platform: "win32", osArchitecture: "x64" };
  assert.throws(() => pinnedAquaCommand(options), /executable is unavailable/u);
  for (const result of [
    { status: 0, stdout: "aqua version 2.61.0" },
    { status: 1, stdout: "aqua version 2.62.3" },
    { status: null, error: { code: "ETIMEDOUT" } },
  ]) {
    let command;
    assert.throws(
      () =>
        pinnedAquaCommand({
          ...options,
          probe: (value) => {
            command = value;
            return result;
          },
        }),
      /executable is unavailable/u,
    );
    assert.equal(command, item.paths.aquaExecutable);
  }
  assert.throws(
    () => pinnedAquaCommand({ ...options, osArchitecture: "unsupported" }),
    /checkout state/u,
  );
});

void test("non-Windows Aqua retains the existing executable lookup", () => {
  for (const platform of ["linux", "darwin"]) assert.equal(pinnedAquaCommand({ platform }), "aqua");
});

void test("Windows ARM64 receipts follow bootstrap OS architecture even with an x64 Node cache path", (t) => {
  const item = aquaFixture(t);
  item.paths.pins.bootstrap.aqua.artifacts["win32-arm64"] = { sha256: "D".repeat(64) };
  writeFileSync(
    `${item.paths.aquaExecutable}.receipt.json`,
    JSON.stringify({
      ...item.receipt,
      archive_sha256: "D".repeat(64),
    }),
  );
  assert.match(item.paths.aquaExecutable, /win32-x64/u);
  const options = {
    paths: item.paths,
    platform: "win32",
    osArchitecture: "arm64",
    probe: () => ({ status: 0, stdout: "aqua version 2.62.3" }),
  };
  assert.equal(pinnedAquaCommand(options), item.paths.aquaExecutable);
  assert.throws(
    () => pinnedAquaCommand({ ...options, osArchitecture: "x64" }),
    /cache receipt does not match/u,
  );
});

void test("selected cached native executable preserves Unicode paths and literal arguments despite PATH collision", (t) => {
  const item = aquaFixture(t);
  // Node stands in for a native payload to inspect argv and executable identity.
  // The injected version probe is fixture evidence, not a live Aqua version claim.
  copyFileSync(process.execPath, item.paths.aquaExecutable);
  const staleDirectory = path.join(item.root, "older PATH candidate");
  mkdirSync(staleDirectory);
  copyFileSync(process.execPath, path.join(staleDirectory, "aqua.exe"));
  const key =
    Object.keys(process.env).find((name: string) => name.toLowerCase() === "path") ?? "PATH";
  const environment = { ...process.env, [key]: staleDirectory };
  const executable = pinnedAquaCommand({
    paths: item.paths,
    platform: "win32",
    osArchitecture: "x64",
    environment,
    probe: () => ({ status: 0, stdout: "aqua version 2.62.3" }),
  });
  const arguments_ = ["space here", "雪 café", "", "&|<>^%!$(literal)`", 'a"b'];
  const result = spawnSync(
    executable,
    [
      "-e",
      "console.log(JSON.stringify({executable:process.execPath,args:process.argv.slice(1)}))",
      "--",
      ...arguments_,
    ],
    {
      cwd: item.paths.projectRoot,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const observed = object(JSON.parse(result.stdout));
  assert.equal(observed.executable, item.paths.aquaExecutable);
  assert.deepEqual(observed.args, arguments_);
  assert.equal(environment[key], staleDirectory);
});

function fixture() {
  const root = path.join(os.tmpdir(), `portcove tool cache 雪-${process.pid}-${Date.now()}`);
  const projectRoot = path.join(root, "checkout");
  const sharedRoot = path.join(root, "shared");
  mkdirSync(projectRoot, { recursive: true });
  const pins = {
    aquaVersion: "v2.62.3",
    aquaSemver: "2.62.3",
    packageManager: "pnpm@12.4.1",
    bootstrap: { schema_version: 1 },
    fingerprint: "a".repeat(64),
    aquaFingerprint: "e".repeat(64),
  };
  const paths = toolCachePaths({
    projectRoot,
    environment: { PORTCOVE_SHARED_TOOL_CACHE: sharedRoot },
    platform: "win32",
    architecture: "x64",
    pins,
  });
  return { root, paths };
}

void test("shared payload paths are stable while checkout shims remain isolated", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const sibling = toolCachePaths({
    projectRoot: path.join(item.root, "other-checkout"),
    environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
    platform: "win32",
    architecture: "x64",
    pins: item.paths.pins,
  });
  assert.equal(sibling.sharedRoot, item.paths.sharedRoot);
  assert.equal(sibling.aquaExecutable, item.paths.aquaExecutable);
  assert.equal(sibling.aquaRoot, item.paths.aquaRoot);
  assert.notEqual(sibling.shimDirectory, item.paths.shimDirectory);
  const changedPins = {
    ...item.paths.pins,
    aquaSemver: "2.63.0",
    fingerprint: "b".repeat(64),
    aquaFingerprint: "f".repeat(64),
  };
  const different = toolCachePaths({
    projectRoot: path.join(item.root, "third-checkout"),
    environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
    platform: "win32",
    architecture: "x64",
    pins: changedPins,
  });
  assert.equal(different.sharedRoot, item.paths.sharedRoot);
  assert.notEqual(different.aquaExecutable, item.paths.aquaExecutable);
  assert.notEqual(different.aquaRoot, item.paths.aquaRoot);
});

function pinnedCheckoutFixture(t: TestContext) {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  for (const name of [
    ".aqua-version",
    "aqua.yaml",
    "aqua-checksums.json",
    ".github/quality-tools.json",
    ".config/tool-bootstrap.json",
    "package.json",
  ]) {
    const target = path.join(item.paths.projectRoot, name);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(new URL(`../${name}`, import.meta.url), target);
  }
  const paths = toolCachePaths({
    projectRoot: item.paths.projectRoot,
    environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
    platform: "win32",
    architecture: "x64",
  });
  return { ...item, paths };
}

function changeJson(contents: string, change: (value: Record<string, unknown>) => void) {
  const value = object(JSON.parse(contents));
  change(value);
  return JSON.stringify(value);
}

void test("unrelated pins preserve the Aqua root while invalidating checkout state", (t) => {
  const item = pinnedCheckoutFixture(t);
  mkdirSync(item.paths.shimDirectory, { recursive: true });
  writeFileSync(
    item.paths.statePath,
    JSON.stringify({
      format_version: 1,
      pin_fingerprint: item.paths.pins.fingerprint,
      shared_root: item.paths.sharedRoot,
      shim_directory: item.paths.shimDirectory,
      aqua_root: item.paths.aquaRoot,
    }),
  );
  assert.notEqual(item.paths.pins.aquaFingerprint, item.paths.pins.fingerprint);
  assert.ok(readToolState({ paths: item.paths }));
  const changes: Change[] = [
    [
      "package.json",
      (text) =>
        changeJson(text, (value) => {
          value.packageManager = "pnpm@99.0.0";
        }),
    ],
    [
      "package.json",
      (text) =>
        changeJson(text, (value) => {
          value.description = "unrelated metadata";
        }),
    ],
    [
      "package.json",
      (text) =>
        changeJson(text, (value) => {
          object(value.scripts).example = "unrelated script";
        }),
    ],
    [
      ".github/quality-tools.json",
      (text) =>
        changeJson(text, (value) => {
          first(array(value.tools).map(object)).version = "99.0.0";
        }),
    ],
    [
      ".config/tool-bootstrap.json",
      (text) =>
        changeJson(text, (value) => {
          object(value.desktop).tauri_driver = "99.0.0";
        }),
    ],
  ];
  for (const [name, change] of changes) {
    const file = path.join(item.paths.projectRoot, name);
    const original = readFileSync(file, "utf8");
    writeFileSync(file, change(original));
    const pins = readToolPins(item.paths.projectRoot);
    const paths = toolCachePaths({
      projectRoot: item.paths.projectRoot,
      environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
      platform: "win32",
      architecture: "x64",
      pins,
    });
    assert.notEqual(pins.fingerprint, item.paths.pins.fingerprint, name);
    assert.equal(pins.aquaFingerprint, item.paths.pins.aquaFingerprint, name);
    assert.equal(paths.aquaRoot, item.paths.aquaRoot, name);
    assert.equal(readToolState({ paths }), null, name);
    writeFileSync(file, original);
  }
});

void test("every Aqua manifest and bootstrap integrity input invalidates its root", (t) => {
  const item = pinnedCheckoutFixture(t);
  const changes: Change[] = [
    [".aqua-version", () => "v99.0.0\n"],
    ["aqua.yaml", (text: string) => text.replace(/ref: v\S+/u, "ref: v99.0.0")],
    ...["astral-sh/ruff", "rhysd/actionlint", "koalaman/shellcheck"].map((name): Change => [
      "aqua.yaml",
      (text: string) => text.replace(new RegExp(`${name}@\\S+`, "u"), `${name}@v99.0.0`),
    ]),
    ...["registries/", "github_release/"].map((prefix): Change => [
      "aqua-checksums.json",
      (text) =>
        changeJson(text, (value) => {
          const entry = array(value.checksums)
            .map(object)
            .find((entry) => stringValue(entry.id).startsWith(prefix));
          assert.ok(entry);
          entry.checksum = entry.checksum === "A".repeat(64) ? "B".repeat(64) : "A".repeat(64);
        }),
    ]),
    ...["win32-x64", "win32-arm64"].map((architecture): Change => [
      ".config/tool-bootstrap.json",
      (text) =>
        changeJson(text, (value) => {
          const artifact = object(object(object(value.aqua).artifacts)[architecture]);
          artifact.sha256 = artifact.sha256 === "A".repeat(64) ? "B".repeat(64) : "A".repeat(64);
        }),
    ]),
  ];
  for (const [name, change] of changes) {
    const file = path.join(item.paths.projectRoot, name);
    const original = readFileSync(file, "utf8");
    const changed = change(original);
    assert.notEqual(changed, original, name);
    writeFileSync(file, changed);
    const pins = readToolPins(item.paths.projectRoot);
    const paths = toolCachePaths({
      projectRoot: item.paths.projectRoot,
      environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
      platform: "win32",
      architecture: "x64",
      pins,
    });
    assert.notEqual(pins.aquaFingerprint, item.paths.pins.aquaFingerprint, name);
    assert.notEqual(paths.aquaRoot, item.paths.aquaRoot, name);
    writeFileSync(file, original);
  }
});

void test("Aqua cache identity preserves official-origin and bootstrap pin rejection", (t) => {
  const item = pinnedCheckoutFixture(t);
  const file = path.join(item.paths.projectRoot, ".config/tool-bootstrap.json");
  const original = readFileSync(file, "utf8");
  const invalidChanges: [(value: Record<string, unknown>) => void, RegExp][] = [
    [
      (value) => {
        object(value.aqua).release_base = "https://example.invalid/aqua";
      },
      /official release origin/u,
    ],
    [
      (value) => {
        object(object(object(value.aqua).artifacts)["win32-x64"]).archive = "arbitrary.zip";
      },
      /invalid Aqua archive/u,
    ],
    [
      (value) => {
        object(object(object(value.aqua).artifacts)["win32-arm64"]).sha256 = "invalid";
      },
      /invalid Aqua SHA-256/u,
    ],
    [
      (value) => {
        value.schema_version = 2;
      },
      /schema_version must be 1/u,
    ],
  ];
  for (const [change, expected] of invalidChanges) {
    writeFileSync(file, changeJson(original, change));
    assert.throws(() => readToolPins(item.paths.projectRoot), expected);
  }
});

void test("supported hosts share Aqua identity and retain separate Aqua executable paths", (t) => {
  const item = pinnedCheckoutFixture(t);
  const executables = new Set();
  for (const platform of ["win32", "linux", "darwin"]) {
    for (const architecture of ["x64", "arm64"]) {
      const paths = toolCachePaths({
        projectRoot: item.paths.projectRoot,
        environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
        platform,
        architecture,
      });
      assert.equal(paths.aquaRoot, item.paths.aquaRoot);
      assert.ok(paths.aquaExecutable.includes(`${platform}-${architecture}`));
      executables.add(paths.aquaExecutable);
    }
  }
  assert.equal(executables.size, 6);
});

void test("historical Aqua roots invalidate checkout state before any executable probe", (t) => {
  const item = aquaFixture(t);
  const legacyRoot = path.join(item.paths.sharedRoot, "aqua-roots", item.paths.pins.fingerprint);
  assert.notEqual(legacyRoot, item.paths.aquaRoot);
  writeFileSync(item.paths.statePath, JSON.stringify({ ...item.state, aqua_root: legacyRoot }));
  assert.equal(readToolState({ paths: item.paths }), null);
  let probes = 0;
  assert.throws(
    () =>
      pinnedAquaCommand({
        paths: item.paths,
        platform: "win32",
        osArchitecture: "x64",
        probe: () => {
          probes++;
          return { status: 0, stdout: "aqua version 2.62.3" };
        },
      }),
    /checkout state.*bootstrap-quality-tools/u,
  );
  assert.equal(probes, 0);
  for (const aquaRoot of [null, path.join(item.root, "unrelated-root")]) {
    writeFileSync(item.paths.statePath, JSON.stringify({ ...item.state, aqua_root: aquaRoot }));
    assert.equal(readToolState({ paths: item.paths }), null);
  }
  writeFileSync(item.paths.statePath, JSON.stringify(item.state));
  assert.ok(readToolState({ paths: item.paths }));
});

void test("checkout environment prepends quality-tool shims without reordering active providers", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const original = { Path: "C:\\Windows", TOKEN: "kept" };
  const result = checkoutToolEnvironment(original, { paths: item.paths, platform: "win32" });
  assert.equal(result.Path, `${item.paths.shimDirectory};C:\\Windows`);
  assert.equal(result.AQUA_ROOT_DIR, item.paths.aquaRoot);
  assert.equal(result.AQUA_ENFORCE_CHECKSUM, "true");
  assert.equal(result.PSModulePath, item.paths.powershellModules);
  assert.equal(result.TOKEN, "kept");
  assert.deepEqual(original, { Path: "C:\\Windows", TOKEN: "kept" });
  const empty = checkoutToolEnvironment({}, { paths: item.paths });
  assert.equal(empty.PATH, item.paths.shimDirectory);
});

void test("checkout children preserve the selected external pnpm provider", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const selected = path.join(item.root, "selected provider");
  const other = path.join(item.root, "other provider");
  const version = readToolPins().packageManager.split("@")[1];
  assert.ok(version);
  for (const [directory, reported] of [
    [selected, version],
    [other, "0.0.0"],
  ] as const) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
      process.platform === "win32"
        ? `@echo off\r\necho ${reported}\r\n`
        : `#!/bin/sh\necho ${reported}\n`,
      { mode: 0o755 },
    );
  }
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const inherited = [selected, path.dirname(process.execPath), other].join(path.delimiter);
  const environment = { ...process.env, [key]: inherited };
  const child = checkoutToolEnvironment(environment, { paths: item.paths });
  assert.equal(child[key], `${item.paths.shimDirectory}${path.delimiter}${inherited}`);
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "pnpm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm --version"] : ["--version"];
  const result = spawnSync(command, args, {
    env: child,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), version);
  assert.equal(environment[key], inherited);
});

void test("state is rejected after pin drift or missing desktop payloads", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  mkdirSync(item.paths.shimDirectory, { recursive: true });
  const state = {
    format_version: 1,
    pin_fingerprint: item.paths.pins.fingerprint,
    shared_root: item.paths.sharedRoot,
    shim_directory: item.paths.shimDirectory,
    aqua_root: item.paths.aquaRoot,
    desktop: {
      tauri_driver: path.join(item.root, "tauri-driver.exe"),
      native_driver: path.join(item.root, "msedgedriver.exe"),
      tauri_driver_sha256: createHash("sha256").update("fixture").digest("hex"),
      native_driver_sha256: createHash("sha256").update("fixture").digest("hex"),
    },
  };
  writeFileSync(item.paths.statePath, JSON.stringify(state));
  assert.deepEqual(readToolState({ paths: item.paths }), state);
  assert.equal(cachedDesktopDrivers({ paths: item.paths }), null);
  writeFileSync(state.desktop.tauri_driver, "fixture");
  writeFileSync(state.desktop.native_driver, "fixture");
  assert.deepEqual(cachedDesktopDrivers({ paths: item.paths }), {
    driver: state.desktop.tauri_driver,
    nativeDriver: state.desktop.native_driver,
  });
  writeFileSync(state.desktop.native_driver, "tampered");
  assert.equal(cachedDesktopDrivers({ paths: item.paths }), null);
  writeFileSync(state.desktop.native_driver, "fixture");
  state.pin_fingerprint = "b".repeat(64);
  writeFileSync(item.paths.statePath, JSON.stringify(state));
  assert.equal(readToolState({ paths: item.paths }), null);
});

void test("unsupported platforms and architectures fail before path provisioning", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  assert.throws(
    () =>
      toolCachePaths({
        projectRoot: item.paths.projectRoot,
        environment: { PORTCOVE_SHARED_TOOL_CACHE: item.paths.sharedRoot },
        platform: "win32",
        architecture: "ia32",
        pins: item.paths.pins,
      }),
    /unsupported tool-cache platform or architecture/u,
  );
});

type Change = [string, (text: string) => string];
function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function stringValue(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
