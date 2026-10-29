import { isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  prerequisiteBash,
  prerequisiteEnvironment,
  prerequisiteImportGuards,
  prerequisiteInvocation,
  prerequisiteOperations,
} from "./fixtures/linux-prerequisites-fixture.mts";
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
import {
  createContainerHost,
  completedContainerPreparation,
  validateNativeBuilder,
} from "./container-host.mts";
void test("preparation builder is native and bound to the validated local context", () => {
  validateNativeBuilder("Driver: docker\r\nEndpoint: desktop-linux\r\n");
  for (const inspection of [
    "Driver: docker-container\nEndpoint: desktop-linux\n",
    "Driver: docker\nEndpoint: tcp://remote:2376\n",
    "Driver: docker\nEndpoint: desktop-linux\nEndpoint: remote\n",
    "Driver: docker\nEndpoint: desktop-linux\n  Endpoint: remote\n",
    "Driver: docker\nDriver: docker-container\nEndpoint: desktop-linux\n",
    "Driver: docker\n",
    "Endpoint: desktop-linux\n",
  ])
    assert.throws(() => validateNativeBuilder(inspection), /native Docker builder/u);
});
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
  const module = fileURLToPath(
    new URL("./install-linux-desktop-prerequisites.sh", import.meta.url),
  ).replaceAll("\\", "/");
  for (const status of [0, 124, 137]) {
    const script = `set -euo pipefail
${prerequisiteImportGuards}
. "$1"
packages=(fixture)
privilege=()
ubuntu_sources=/fixture/missing-source
apt_mirror_file=/fixture/missing-mirrors
prefer_archive_mirror=false
install_deadline=3600s
fallback_install_deadline=3600s
use_archive_mirror() { echo unexpected-mirror-retry; return 99; }
run_apt() { echo "apt-call:$2"; if [[ $2 == install ]]; then return ${status}; fi; }
execute_desktop_prerequisites`;
    if (status === 0) {
      const result = await command(bash, ["-c", script, "fixture", module]);
      assert.equal(result.stdout.match(/apt-call:/gu)?.length, 2);
      assert(!result.stdout.includes("unexpected-mirror-retry"));
    } else {
      await assert.rejects(command(bash, ["-c", script, "fixture", module]), (error) => {
        assertCommandFailure(error);
        assert.equal(error.result.status, status);
        assert.match(error.result.stderr, /refusing a mirror retry/u);
        return true;
      });
    }
  }
  for (const status of [0, 100, 124, 137]) {
    const script = `set -euo pipefail
${prerequisiteImportGuards}
. "$1"
packages=(fixture)
privilege=()
ubuntu_sources=/fixture/missing-source
apt_mirror_file=/fixture/missing-mirrors
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
execute_desktop_prerequisites`;
    if (status === 0) {
      const result = await command(bash, ["-c", script, "fixture", module]);
      assert.equal(result.stdout.match(/apt-call:/gu)?.length, 4);
    } else {
      await assert.rejects(command(bash, ["-c", script, "fixture", module]), (error) => {
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
  const module = fileURLToPath(
    new URL("./install-linux-desktop-prerequisites.sh", import.meta.url),
  ).replaceAll("\\", "/");
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
${prerequisiteImportGuards}
. "$1"
privilege=()
sed() { command sed "$@"; }
use_archive_mirror "$2" "$3"`,
      "fixture",
      module,
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
    for (const enabled of [false, true]) {
      const selectedRoute = await command(bash, [
        "-c",
        `set -euo pipefail
${prerequisiteImportGuards}
. "$1"
packages=(fixture)
ubuntu_sources=/fixture/missing-source
apt_mirror_file=/fixture/missing-mirrors
install_deadline=3m
fallback_install_deadline=5m
prefer_archive_mirror=${enabled}
use_archive_mirror() { echo route-selected; }
run_apt() { return 0; }
execute_desktop_prerequisites`,
        "fixture",
        module,
      ]);
      assert.equal(selectedRoute.stdout.includes("route-selected"), enabled);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("prerequisite import performs no command I/O and preserves strict and ordinary shell options", () => {
  const source = fileURLToPath(
    new URL("./install-linux-desktop-prerequisites.sh", import.meta.url),
  ).replaceAll("\\", "/");
  for (const options of ["set +e +u; set +o pipefail", "set -euo pipefail"]) {
    const result = spawnSync(
      prerequisiteBash(),
      [
        "--noprofile",
        "--norc",
        "-c",
        `
${options}
before=$-
dpkg-query() { echo unexpected-query; return 99; }
sudo() { echo unexpected-sudo; return 99; }
apt-get() { echo unexpected-install; return 99; }
sed() { echo unexpected-rewrite; return 99; }
${prerequisiteImportGuards}
. "$1"
status=$?
[[ $status == 0 && $- == "$before" ]]
`,
        "source-only",
        source,
      ],
      { env: prerequisiteEnvironment(), encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

void test("prerequisite privilege selection requires noninteractive authorization before mutation", () => {
  for (const [identity, available, status, expected] of [
    [0, false, 1, 0],
    [1000, false, 0, 1],
    [1000, true, 1, 1],
    [1000, true, 0, 0],
  ] as const) {
    const result = prerequisiteOperations(`
command() { if [[ $1 == -v && $2 == sudo ]]; then return ${available ? 0 : 1}; fi; builtin command "$@"; }
sudo() { printf 'sudo:%s:%s\\n' "$1" "$2"; [[ $1 == -n && $2 == true ]] || return 99; return ${status}; }
if desktop_prerequisite_privilege ${identity}; then result=0; else result=$?; fi
printf 'result:%s\\n' "$result"
if (( result == 0 )); then printf 'wrapper:%s\\n' "\${privilege[*]}"; fi
`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`result:${expected}\n`), result.stdout);
    assert.equal(result.stdout.includes("sudo:-n:true"), identity !== 0 && available);
    if (expected === 0)
      assert.ok(
        result.stdout.includes(`wrapper:${identity === 0 ? "" : "sudo -n"}\n`),
        result.stdout,
      );
  }
});

void test("real prerequisite main returns for already installed packages without APT or mirror mutation", () => {
  const result = prerequisiteOperations(`
dpkg-query() { printf 'ii '; }
apt-get() { echo forbidden-package-mutation; return 99; }
sed() { echo forbidden-source-mutation; return 99; }
sudo() { echo forbidden-privilege-request; return 99; }
main --include-rpm --include-appimage-runtime
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already installed/u);
  assert.doesNotMatch(result.stdout, /forbidden-/u);
});

void test("workflow prerequisite arguments tolerate quoting, flag order and continuation formatting", () => {
  const expected = [
    "--include-rpm",
    "--prefer-archive-mirror",
    "--install-timeout-seconds=600",
  ].toSorted();
  for (const run of [
    "./scripts/install-linux-desktop-prerequisites.sh --include-rpm --prefer-archive-mirror --install-timeout-seconds=600",
    'bash "./scripts/install-linux-desktop-prerequisites.sh" "--install-timeout-seconds=600" --include-rpm --prefer-archive-mirror',
    "'./scripts/install-linux-desktop-prerequisites.sh' --prefer-archive-mirror \\\n  --include-rpm --install-timeout-seconds=600",
  ])
    assert.deepEqual(prerequisiteInvocation(run).toSorted(), expected);
  for (const run of [
    "./scripts/install-linux-desktop-prerequisites.sh; touch unexpected",
    "./scripts/install-linux-desktop-prerequisites.sh $(echo injection)",
    "bash other-script.sh",
  ])
    assert.throws(() => prerequisiteInvocation(run));
});

void test("sourceable prerequisite planning preserves packages, budgets and caller shell options", () => {
  const base = ["libwebkit2gtk-4.1-dev", "libappindicator3-dev", "librsvg2-dev", "patchelf"];
  for (const [id, version, flags, extra] of [
    ["ubuntu", "22.04", [], []],
    [
      "ubuntu",
      "24.04",
      ["--include-appimage-runtime"],
      ["libfuse2t64", "xvfb", "dbus-x11", "at-spi2-core", "util-linux"],
    ],
    [
      "ubuntu",
      "22.04",
      ["--include-appimage-runtime"],
      ["libfuse2", "xvfb", "dbus-x11", "at-spi2-core", "util-linux"],
    ],
    [
      "debian",
      "24.04",
      ["--include-appimage-runtime"],
      ["libfuse2", "xvfb", "dbus-x11", "at-spi2-core", "util-linux"],
    ],
    [
      "ubuntu",
      "24.04",
      ["--include-rpm", "--include-dialog-tests", "--include-webdriver"],
      ["rpm", "xvfb", "xauth", "webkit2gtk-driver", "xvfb", "dbus-x11"],
    ],
  ] as const) {
    const result = prerequisiteOperations(
      String.raw`
plan_desktop_prerequisites "$@"
printf '%s\0' "$install_deadline" "$fallback_install_deadline" "$prefer_archive_mirror" "${"${packages[@]}"}"
`,
      [id, version, ...flags],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.slice(0, -1).split("\0"), [
      "3m",
      "5m",
      "false",
      ...base,
      ...extra,
    ]);
  }
  for (const deadline of ["180", "0180", "600", "3600"]) {
    const result = prerequisiteOperations(
      String.raw`
plan_desktop_prerequisites ubuntu 24.04 --prefer-archive-mirror "--install-timeout-seconds=$1"
printf '%s\0' "$install_deadline" "$fallback_install_deadline" "$prefer_archive_mirror"
plan_desktop_prerequisites ubuntu 22.04
printf '%s\0' "$install_deadline" "$fallback_install_deadline" "$prefer_archive_mirror"
`,
      [deadline],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.slice(0, -1).split("\0"), [
      `${Number(deadline)}s`,
      `${Number(deadline)}s`,
      "true",
      "3m",
      "5m",
      "false",
    ]);
  }
});

function assertAptOperation(sourcePath?: string) {
  const result = prerequisiteOperations(
    String.raw`
privilege=(sudo -n)
desktop_prerequisite_apt_options '/owned/source with spaces'
sudo() { printf '%s\0' sudo "$@" ''; [[ $1 == -n ]]; shift; "$@"; }
timeout() { printf '%s\0' timeout "$@" ''; [[ $1 == --kill-after=10s && $2 == 600s ]]; shift 2; "$@"; }
env() { printf '%s\0' env "$@" ''; [[ $1 == DEBIAN_FRONTEND=noninteractive ]]; shift; "$@"; }
apt-get() { printf '%s\0' apt-get "$@" ''; }
run_apt 600s install --yes --no-install-recommends literal-package
`,
    [],
    sourcePath,
  );
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout
    .split("\0\0")
    .filter(Boolean)
    .map((line) => line.split("\0"));
  const apt = [
    "apt-get",
    "-o",
    "Dir::Etc::sourcelist=/owned/source with spaces",
    "-o",
    "Dir::Etc::sourceparts=-",
    "-o",
    "Acquire::http::Timeout=30",
    "-o",
    "Acquire::https::Timeout=30",
    "-o",
    "Acquire::Retries=3",
    "-o",
    "DPkg::Lock::Timeout=60",
    "install",
    "--yes",
    "--no-install-recommends",
    "literal-package",
  ];
  const environment = ["env", "DEBIAN_FRONTEND=noninteractive", ...apt];
  const timeout = ["timeout", "--kill-after=10s", "600s", ...environment];
  assert.deepEqual(records, [["sudo", "-n", ...timeout], timeout, environment, apt]);
}
void test("APT operation keeps privilege outside timeout and consumes every bounded isolated option", () =>
  assertAptOperation());

void test("APT update failure retains the existing fallback route rather than install-timeout semantics", () => {
  for (const updateStatus of [100, 124, 137]) {
    const result = prerequisiteOperations(
      String.raw`
packages=(fixture); privilege=(); ubuntu_sources=/fixture/missing; apt_mirror_file=/fixture/missing-mirrors
prefer_archive_mirror=false; install_deadline=3m; fallback_install_deadline=5m
updates=0
use_archive_mirror() { echo fallback-selected; }
run_apt() { printf 'call:%s:%s\n' "$1" "$2"; if [[ $2 == update ]]; then updates=$((updates+1)); if (( updates == 1 )); then return "$1_STATUS"; fi; fi; }
execute_desktop_prerequisites
`.replace('"$1_STATUS"', String(updateStatus)),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.stdout
        .split("\n")
        .filter((line) => line.startsWith("call:") || line === "fallback-selected"),
      ["call:2m:update", "fallback-selected", "call:4m:update", "call:5m:install"],
    );
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
