import { isRecord } from "./runtime-values.mts";
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
void test("missing package tools preserve the failed executable and arguments", async () => {
  const missing = path.join(os.tmpdir(), "portcove-missing-tool-parent-does-not-exist", "rpm");
  assert(!existsSync(missing));
  await assert.rejects(command(missing, ["-qp", "literal package;name.rpm"]), (error) => {
    assertCommandFailure(error);
    assert.match(error.message, /ENOENT/u);
    assert.equal(error.result.command, missing);
    assert.deepEqual(error.result.args, ["-qp", "literal package;name.rpm"]);
    assert.notEqual(error.result.status, 0);
    return true;
  });
});
void test("canonical APT helper rejects invalid explicit deadlines before installation", async () => {
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
        assertCommandFailure(error);
        assert.equal(error.result.status, 2);
        assert.match(error.result.stderr, /180\.\.3600 seconds/u);
        return true;
      },
    );
});
void test("APT install deadlines preserve failure and stop before mirror retry", async () => {
  const git = await command("git", ["--exec-path"]);
  const bash =
    process.platform === "win32"
      ? path.resolve(git.stdout.trim(), "../../../bin/bash.exe")
      : "bash";
  const source = readFileSync("scripts/install-linux-desktop-prerequisites.sh", "utf8");
  const control = source.slice(
    source.indexOf("install_from_current_mirror() {"),
    source.indexOf("# GitHub's Azure-backed Ubuntu mirror"),
  );
  for (const status of [0, 124, 137]) {
    const script = `set -euo pipefail
packages=(fixture)
install_deadline=3600s
run_apt() { echo "apt-call:$2"; if [[ $2 == install ]]; then return ${status}; fi; }
${control}
echo unexpected-mirror-retry
exit 99`;
    if (status === 0) {
      const result = await command(bash, ["-c", script]);
      assert.equal(result.stdout.match(/apt-call:/gu)?.length, 2);
      assert(!result.stdout.includes("unexpected-mirror-retry"));
    } else {
      await assert.rejects(command(bash, ["-c", script]), (error) => {
        assertCommandFailure(error);
        assert.equal(error.result.status, status);
        assert.match(error.result.stderr, /refusing a mirror retry/u);
        return true;
      });
    }
  }
  const fullControl = source.slice(source.indexOf("use_archive_mirror() {"));
  for (const status of [0, 100, 124, 137]) {
    const script = `set -euo pipefail
packages=(fixture)
privilege=()
ubuntu_sources=/fixture/missing-source
prefer_archive_mirror=false
install_deadline=3600s
fallback_install_deadline=3600s
installs=0
sed() { :; }
run_apt() {
  echo "apt-call:$2"
  if [[ $2 == install ]]; then
    installs=$((installs + 1))
    if (( installs == 1 )); then return 100; fi
    return ${status}
  fi
}
${fullControl}`;
    if (status === 0) {
      const result = await command(bash, ["-c", script]);
      assert.equal(result.stdout.match(/apt-call:/gu)?.length, 4);
    } else {
      await assert.rejects(command(bash, ["-c", script]), (error) => {
        assertCommandFailure(error);
        assert.equal(error.result.status, status);
        assert.match(error.result.stderr, /either bounded mirror attempt/u);
        return true;
      });
    }
  }
});
void test("APT archive preference rewrites only the selected Azure Ubuntu routes", async () => {
  const git = await command("git", ["--exec-path"]);
  const bash =
    process.platform === "win32"
      ? path.resolve(git.stdout.trim(), "../../../bin/bash.exe")
      : "bash";
  const source = readFileSync("scripts/install-linux-desktop-prerequisites.sh", "utf8");
  const start = source.indexOf("use_archive_mirror() {");
  const selection = source.indexOf("if [[ $prefer_archive_mirror == true ]]");
  assert(start > 0 && selection > start);
  const rewrite = source
    .slice(start, selection)
    .replace("/etc/apt/apt-mirrors.txt", '"$fixture_mirror_file"');
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-apt-mirror-"));
  try {
    const selected = path.join(root, "ubuntu.sources");
    const mirrors = path.join(root, "apt-mirrors.txt");
    const unchanged = [
      "https://security.ubuntu.com/ubuntu",
      "https://custom.example/ubuntu",
      "https://custom.example/proxy/https://azure.archive.ubuntu.com/ubuntu",
      "https://azure.archive.ubuntu.com.evil/ubuntu",
      "https://notazure.archive.ubuntu.com/ubuntu",
      "https://azure.archive.ubuntu.com/ubuntu-extra",
    ].join("\n");
    writeFileSync(
      selected,
      `Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu https://azure.archive.ubuntu.com/ubuntu/\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\n${unchanged}\n`,
    );
    writeFileSync(mirrors, `http://azure.archive.ubuntu.com/ubuntu\n${unchanged}\n`);
    const result = await command(bash, [
      "-c",
      `set -euo pipefail
privilege=()
ubuntu_sources=$1
fixture_mirror_file=$2
${rewrite}
use_archive_mirror`,
      "fixture",
      selected.replaceAll("\\", "/"),
      mirrors.replaceAll("\\", "/"),
    ]);
    assert.equal(result.status, 0);
    assert.equal(
      readFileSync(selected, "utf8"),
      `Types: deb\nURIs: https://archive.ubuntu.com/ubuntu https://archive.ubuntu.com/ubuntu/\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\n${unchanged}\n`,
    );
    assert.equal(
      readFileSync(mirrors, "utf8"),
      `https://archive.ubuntu.com/ubuntu\n${unchanged}\n`,
    );
    const selector = source.slice(selection, source.indexOf("install_from_current_mirror() {"));
    for (const enabled of [false, true]) {
      const selectedRoute = await command(bash, [
        "-c",
        `set -euo pipefail
prefer_archive_mirror=${enabled}
use_archive_mirror() { echo route-selected; }
${selector}`,
      ]);
      assert.equal(selectedRoute.stdout.includes("route-selected"), enabled);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("package member inspection requires the exact regular executable", () => {
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
void test("builder modes are closed and isolated from browser resources", async () => {
  assert.throws(() => createContainerHost("arbitrary"), /Unknown/u);
  assert.equal(budgets.timeout_ms, 90 * 60000);
  assert.equal(budgets.setup_ms, 120 * 60000);
  assert.equal(budgets.bundle_ms, 45 * 60000);
  for (const mode of ["suite", "probe", "exact", "arbitrary"])
    // @ts-expect-error Missing commit is deliberate: reject an unsupported mode before source discovery.
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
  assert.throws(() => {
    // @ts-expect-error Deliberately incomplete/foreign runtime identity must be rejected first.
    runtimeArguments({ name: "portcove-browser-30000000-0000-4000-8000-000000000000" });
  }, /Invalid owned/u);
  const fixture = acceptedRuntimeFixture();
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
void test("stale outputs and failed format commands cannot become package acceptance", () => {
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
void test("package identities reject another version or architecture", () => {
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

void test("pre-container recovery requires exact terminal engine evidence, preserving failed status", () => {
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
    { created_at: 0 },
    { completed_at: 0 },
    { completed_at: "2026-10-16T23:00:00Z" },
  ])
    assert.equal(completedContainerPreparation([{ ...record, ...changed }], record.name), null);
  assert.equal(completedContainerPreparation([record, record], record.name), null);
  assert.equal(completedContainerPreparation([record], "another-run"), null);
  assert.equal(record.status, "Error");
});

void test("builder runtime producer environment preserves guest admission and rejects host state", () => {
  const fixture = structuredClone(acceptedRuntimeFixture());
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
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--env") fixture.Config.Env.push(runtimeArgument(args, ++i));
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

function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function acceptedRuntimeFixture() {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL("./testdata/container-browser-runtime-oracle.json", import.meta.url),
      "utf8",
    ),
  );
  const entries = object(raw).runtimeValidation;
  assert.ok(Array.isArray(entries));
  const observations: unknown[] = entries;
  const selected = observations.find((entry) => object(object(entry).expected).accepted === true);
  const input = object(object(selected).input),
    host = object(input.HostConfig),
    config = object(input.Config);
  const environment = config.Env;
  assert.ok(Array.isArray(environment));
  const variables: unknown[] = environment;
  assert.ok(variables.every((value) => typeof value === "string"));
  assert.ok(typeof host.NetworkMode === "string");
  return {
    ...input,
    HostConfig: { ...host, NetworkMode: host.NetworkMode },
    Config: { ...config, Env: variables },
  };
}
function runtimeArgument(values: readonly unknown[], index: number): string {
  const value = values[index];
  assert.ok(typeof value === "string");
  return value;
}
function assertCommandFailure(error: unknown): asserts error is Error & {
  result: { command: string; args: string[]; status: number | null; stderr: string };
} {
  assert.ok(error instanceof Error);
  const result = object(Reflect.get(error, "result"));
  assert.ok(
    typeof result.command === "string" &&
      Array.isArray(result.args) &&
      result.args.every((arg: unknown) => typeof arg === "string") &&
      (result.status === null || typeof result.status === "number") &&
      typeof result.stderr === "string",
  );
}
