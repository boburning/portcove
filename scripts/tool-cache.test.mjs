import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cachedDesktopDrivers,
  checkoutToolEnvironment,
  readToolState,
  toolCachePaths,
} from "./tool-cache.mjs";

function fixture() {
  const root = path.join(os.tmpdir(), `portcove-tool-cache-${process.pid}-${Date.now()}`);
  const projectRoot = path.join(root, "checkout");
  const sharedRoot = path.join(root, "shared");
  mkdirSync(projectRoot, { recursive: true });
  const pins = {
    aquaVersion: "v2.62.3",
    aquaSemver: "2.62.3",
    packageManager: "pnpm@11.25.0",
    bootstrap: { schema_version: 1 },
    fingerprint: "a".repeat(64),
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

test("shared payload paths are stable while checkout shims remain isolated", (t) => {
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
  const changedPins = { ...item.paths.pins, aquaSemver: "2.63.0", fingerprint: "b".repeat(64) };
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

test("checkout environment prepends only the local shims and scopes Aqua", (t) => {
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
});

test("state is rejected after pin drift or missing desktop payloads", (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  mkdirSync(item.paths.shimDirectory, { recursive: true });
  const state = {
    format_version: 1,
    pin_fingerprint: item.paths.pins.fingerprint,
    shared_root: item.paths.sharedRoot,
    shim_directory: item.paths.shimDirectory,
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

test("unsupported platforms and architectures fail before path provisioning", (t) => {
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
