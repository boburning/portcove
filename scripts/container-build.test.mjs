import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertFreshBuildOutputs,
  builtPackage,
  validatePackageMetadata,
} from "./container-build-policy.mjs";
import { runtimeArguments, validateRuntime, budgets, browser } from "./container-build.mjs";
import { createContainerHost } from "./container-host.mjs";
test("builder modes are closed and isolated from browser resources", async () => {
  assert.throws(() => createContainerHost("arbitrary"), /Unknown/u);
  assert.equal(budgets.timeout_ms, 90 * 60000);
  assert.equal(budgets.setup_ms, 60 * 60000);
  for (const mode of ["suite", "probe", "exact", "arbitrary"])
    await assert.rejects(browser({ mode }), /Use check or package/u);
  const args = runtimeArguments({
    name: "portcove-build-30000000-0000-4000-8000-000000000000",
    run: "30000000-0000-4000-8000-000000000000",
    image: "sha256:fixture",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    mode: "package",
  });
  assert(args.includes("io.portcove.tool=build-v1"));
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
  assert(!args.includes("--volume"));
  assert(!args.includes("--mount"));
  assert.throws(
    () => runtimeArguments({ name: "portcove-browser-30000000-0000-4000-8000-000000000000" }),
    /Invalid owned/u,
  );
  const fixture = JSON.parse(
    await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./testdata/container-browser-runtime-oracle.json", import.meta.url)),
    ),
  ).runtimeValidation.find((item) => item.expected.accepted).input;
  fixture.HostConfig.NetworkMode = "bridge";
  validateRuntime(fixture);
  for (const widened of [
    { PortBindings: { "9222/tcp": [{ HostIp: "0.0.0.0", HostPort: "9222" }] } },
    { PublishAllPorts: true },
  ]) {
    const bad = structuredClone(fixture);
    Object.assign(bad.HostConfig, widened);
    assert.throws(() => validateRuntime(bad), /isolation/u);
  }
  for (const key of ["TAURI_SIGNING_PRIVATE_KEY=fixture", "GITHUB_TOKEN=fixture"]) {
    const bad = structuredClone(fixture);
    bad.Config.Env.push(key);
    assert.throws(() => validateRuntime(bad), /Unexpected runtime/u);
  }
});
test("stale outputs and failed format commands cannot become package acceptance", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-builder-policy-"));
  try {
    assertFreshBuildOutputs(root);
    mkdirSync(path.join(root, "target"));
    assert.throws(() => assertFreshBuildOutputs(root), /Stale/u);
    const file = path.join(root, "fresh.deb");
    writeFileSync(file, "!<arch>\nfixture");
    assert.equal(builtPackage(root, "deb", { code: 0, signal: null }), file);
    assert.throws(() => builtPackage(root, "deb", { code: 23, signal: null }), /command failed/u);
    assert.throws(
      () => builtPackage(root, "deb", { code: 0, signal: "SIGTERM" }),
      /command failed/u,
    );
    writeFileSync(path.join(root, "duplicate.deb"), "!<arch>\nfixture");
    assert.throws(() => builtPackage(root, "deb", { code: 0 }), /exactly one/u);
    assert.throws(() => builtPackage(root, "rpm", { code: 0 }), /exactly one/u);
    writeFileSync(path.join(root, "bad.rpm"), "not an rpm");
    assert.throws(() => builtPackage(root, "rpm", { code: 0 }), /signature/u);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("package identities reject another version or architecture", () => {
  assert.equal(
    validatePackageMetadata("deb", "portcove\n0.1.0-alpha.2\namd64\n", "0.1.0-alpha.2")
      .architecture,
    "amd64",
  );
  assert.throws(
    () => validatePackageMetadata("deb", "portcove\n9.0.0\namd64", "0.1.0-alpha.2"),
    /identity/u,
  );
  assert.throws(
    () => validatePackageMetadata("deb", "portcove\n0.1.0-alpha.2\narm64", "0.1.0-alpha.2"),
    /identity/u,
  );
  assert.equal(
    validatePackageMetadata("rpm", "Portcove\n0.1.0\n0.alpha.2\nx86_64", "0.1.0-alpha.2")
      .architecture,
    "x86_64",
  );
  assert.throws(
    () => validatePackageMetadata("rpm", "Portcove\n0.1.0\n1\nx86_64", "0.1.0-alpha.2"),
    /identity/u,
  );
});
