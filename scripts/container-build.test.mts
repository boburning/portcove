import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertFreshBuildOutputs,
  assertPackageExecutable,
  builtPackage,
  validatePackageMetadata,
} from "./container-build-policy.mts";
import {
  runtimeArguments,
  validateRuntime,
  budgets,
  browser,
  command,
} from "./container-build.mts";
import { createContainerHost, completedContainerPreparation } from "./container-host.mts";
test("missing package tools preserve the failed executable and arguments", async () => {
  const missing = path.join(os.tmpdir(), "portcove-missing-tool-parent-does-not-exist", "rpm");
  assert(!existsSync(missing));
  await assert.rejects(command(missing, ["-qp", "literal package;name.rpm"]), (error) => {
    assert.match(error.message, /ENOENT/u);
    assert.equal(error.result.command, missing);
    assert.deepEqual(error.result.args, ["-qp", "literal package;name.rpm"]);
    assert.notEqual(error.result.status, 0);
    return true;
  });
});
test("canonical APT helper rejects invalid explicit deadlines before installation", async () => {
  const git = await command("git", ["--exec-path"]);
  const bash =
    process.platform === "win32"
      ? path.resolve(git.stdout.trim(), "../../../bin/bash.exe")
      : "bash";
  if (process.platform === "win32") assert(existsSync(bash));
  for (const value of ["0", "179", "3601", "unbounded", "1.5", "999999999999999999"])
    await assert.rejects(
      command(bash, [
        "scripts/install-linux-desktop-prerequisites.sh",
        `--install-timeout-seconds=${value}`,
      ]),
      (error) => {
        assert.equal(error.result.status, 2);
        assert.match(error.result.stderr, /180\.\.3600 seconds/u);
        return true;
      },
    );
});
test("package member inspection requires the exact regular executable", () => {
  const deb = "-rwxr-xr-x root/root 123 2026-10-16 00:00 ./usr/bin/portcove-desktop";
  const rpm = "/usr/bin/portcove-desktop 123 1700000000 abcd 0100755 root root 0 0 0 X";
  assertPackageExecutable("deb", deb);
  assertPackageExecutable("rpm", rpm);
  const link = deb.replace("-rwxr-xr-x", "lrwxrwxrwx") + " -> /tmp/other";
  const directory = deb.replace("-rwxr-xr-x", "drwxr-xr-x") + "/";
  const hardlink = deb.replace("-rwxr-xr-x", "hrwxr-xr-x") + " link to ./other";
  for (const other of [link, directory, hardlink, "invalid record ./usr/bin/portcove-desktop"])
    for (const listing of [`${deb}\n${other}`, `${other}\n${deb}`])
      assert.throws(() => assertPackageExecutable("deb", listing), /regular executable/u);
  for (const listing of [
    deb.replace("desktop", "desktop-old"),
    deb.replace("-rwx", "drwx"),
    deb.replace("-rwx", "lrwx"),
    deb.replace("-rwx", "-rw-"),
    `${deb}\n${deb}`,
  ])
    assert.throws(() => assertPackageExecutable("deb", listing), /regular executable/u);
  for (const listing of [
    rpm.replace("desktop", "desktop-old"),
    rpm.replace("0100755", "0040755"),
    rpm.replace("0100755", "0120777"),
    rpm.replace("0100755", "0100644"),
    `${rpm}\n${rpm}`,
  ])
    assert.throws(() => assertPackageExecutable("rpm", listing), /regular executable/u);
});
test("builder modes are closed and isolated from browser resources", async () => {
  assert.throws(() => createContainerHost("arbitrary"), /Unknown/u);
  assert.equal(budgets.timeout_ms, 90 * 60000);
  assert.equal(budgets.setup_ms, 90 * 60000);
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
    validatePackageMetadata("rpm", "portcove\n0.1.0-alpha.2\n1\nx86_64", "0.1.0-alpha.2")
      .architecture,
    "x86_64",
  );
  assert.equal(
    validatePackageMetadata("rpm", "portcove\n0.1.0\n1\nx86_64", "0.1.0").version,
    "0.1.0",
  );
  for (const metadata of [
    "portcove\n0.1.0\n0.alpha.2\nx86_64",
    "portcove\n0.1.0\n1\nx86_64",
    "portcove\n0.1.0-alpha.20\n1\nx86_64",
    "portcove\n0.1.0-alpha.2.extra\n1\nx86_64",
    "Portcove\n0.1.0-alpha.2\n1\nx86_64",
    "portcove-desktop\n0.1.0-alpha.2\n1\nx86_64",
    "portcove\n0.1.0-alpha.2\n1\naarch64",
  ])
    assert.throws(() => validatePackageMetadata("rpm", metadata, "0.1.0-alpha.2"), /identity/u);
  for (const release of [
    "0.alpha.2",
    "0.alpha.20",
    "0.not-alpha.2-unrelated",
    "0.alpha.2.extra",
    "2",
  ])
    assert.throws(
      () =>
        validatePackageMetadata(
          "rpm",
          `portcove\n0.1.0-alpha.2\n${release}\nx86_64`,
          "0.1.0-alpha.2",
        ),
      /identity/u,
    );
});

test("pre-container recovery requires exact terminal engine evidence, preserving failed status", () => {
  const record = {
    name: "portcove-build-exact-run",
    ref: "desktop-linux/desktop-linux/opaque123",
    status: "Error",
    created_at: "2026-10-17T00:00:00Z",
    completed_at: "2026-10-17T00:01:00Z",
  };
  assert.equal(completedContainerPreparation([record], record.name), record);
  for (const changed of [
    { status: "Running" },
    { completed_at: null },
    { ref: "foreign/builder/opaque123" },
    { created_at: "unknown" },
    { completed_at: "2026-10-16T23:00:00Z" },
  ])
    assert.equal(completedContainerPreparation([{ ...record, ...changed }], record.name), null);
  assert.equal(completedContainerPreparation([record, record], record.name), null);
  assert.equal(completedContainerPreparation([record], "another-run"), null);
  assert.equal(record.status, "Error");
});

test("builder runtime producer environment preserves guest admission and rejects host state", () => {
  const fixture = structuredClone(
    JSON.parse(
      readFileSync(new URL("./testdata/container-browser-runtime-oracle.json", import.meta.url)),
    ).runtimeValidation.find((item) => item.expected.accepted).input,
  );
  fixture.HostConfig.NetworkMode = "bridge";
  const run = "30000000-0000-4000-8000-000000000000";
  const args = runtimeArguments({
    name: `portcove-build-${run}`,
    run,
    image: "sha256:owned",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    mode: "check",
  });
  for (let i = 0; i < args.length; i++) if (args[i] === "--env") fixture.Config.Env.push(args[++i]);
  validateRuntime(fixture);
  for (const value of [
    "PORTCOVE_CONTAINER_GUEST=0",
    "PORTCOVE_RESOURCE_RESERVATION=host-record",
    "PORTCOVE_HEAVY_RUST_PROCESS_TOKEN=host-token",
  ]) {
    const bad = structuredClone(fixture);
    bad.Config.Env.push(value);
    assert.throws(() => validateRuntime(bad), /Unexpected runtime environment key/);
  }
});
