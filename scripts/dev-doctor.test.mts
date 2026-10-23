import type { ToolDefinition, DoctorOptions } from "./dev-doctor.mts";
import { readToolPins, toolCachePaths } from "./tool-cache.mts";
import { loadQualityManifest } from "./quality-tools.mts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnCommand } from "./dev-storage.mts";
import {
  collectProfileDoctor,
  probeTool,
  selectedPrerequisites,
  collectSelectedPrerequisites,
  pnpmDefinition,
  existingAquaDefinition,
  existingNpmDefinition,
  cachedRustDefinition,
} from "./dev-doctor.mts";

void test("Windows desktop doctor probes pinned Rust payloads without ambient executable fallback", async () => {
  const manifest = await loadQualityManifest();
  const cargoRoot = path.join(os.tmpdir(), "portcove-absent-doctor-cache");
  for (const tool of manifest.tools.filter((item) => item.tier === "required")) {
    const definition = cachedRustDefinition(tool, { cargoRoot }, "win32");
    const binary = tool.id === "rscheck-cli" ? "rscheck" : tool.crate;
    assert.deepEqual(definition.command, [
      path.join(cargoRoot, tool.crate, tool.version, "bin", `${binary}.exe`),
      "--version",
    ]);
    const calls: string[] = [];
    const result = probeTool(definition, (command) => {
      calls.push(command);
      return { status: null, error: Object.assign(new Error("absent"), { code: "ENOENT" }) };
    });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(calls, [definition.command[0]]);
    assert.equal(cachedRustDefinition(tool, { cargoRoot }, "linux").command[0], binary);
  }
});

void test("selected Windows Cargo prerequisites probe pinned payloads instead of Cargo PATH lookup", async () => {
  const manifest = await loadQualityManifest();
  const tools = manifest.tools.filter((tool) =>
    ["cargo-nextest", "cargo-shear", "cargo-deny"].includes(tool.id),
  );
  const expected = tools.map((tool) => cachedRustDefinition(tool, toolCachePaths(), "win32"));
  for (const available of [true, true, false]) {
    const calls: string[][] = [];
    const observations = await collectSelectedPrerequisites([], {
      platform: "win32",
      capabilities: tools.map((tool) => tool.id),
      run: (command, args) => {
        calls.push([command, ...args]);
        const definition = expected.find((item) => item.command[0] === command);
        assert.ok(definition, "No ambient Cargo subcommand or provisioning fallback is allowed");
        assert.ok(typeof definition.version === "string");
        return available
          ? { status: 0, stdout: definition.version }
          : { status: null, error: Object.assign(new Error("absent"), { code: "ENOENT" }) };
      },
    });
    assert.deepEqual(
      calls,
      expected.map((definition) => definition.command),
    );
    assert.ok(observations.every((item) => item.status === (available ? "ok" : "unavailable")));
  }
});

void test("selected frontend prerequisites do not invoke Rust, native provisioning or bootstrap", async () => {
  const calls: [string, string[]][] = [];
  let pnpmVersion: string | undefined;
  const report = await collectSelectedPrerequisites([{ id: "oxfmt" }], {
    pnpmDefinition: (version) => {
      pnpmVersion = version;
      return { id: "pnpm", version, command: ["cached-pnpm", "--version"] };
    },
    run: (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.env?.RUSTUP_AUTO_INSTALL, "0");
      return { status: 0, stdout: command === "cached-pnpm" ? pnpmVersion : "v24.21.0" };
    },
  });
  assert.deepEqual(
    report.map((entry) => entry.id),
    ["node", "pnpm", "frontend-dependencies"],
  );
  assert.equal(calls.length, 2);
  assert.equal(requiredFixture(report.find((entry) => entry.id === "pnpm")).status, "ok");
  assert.ok(calls.every(([command]) => command !== "cargo" && command !== "rustc"));
});

void test("selected native compilation reports missing Linux libraries without installing them", async () => {
  const calls: [string, string[]][] = [];
  const report = await collectSelectedPrerequisites([{ id: "rust-clippy:portcove-desktop" }], {
    platform: "linux",
    run: (command, args) => {
      calls.push([command, args]);
      return {
        status: command === "pkg-config" ? 1 : 0,
        stdout: command === "rustc" ? "1.98.1" : "24.21.0",
      };
    },
  });
  assert.equal(
    requiredFixture(report.find((item) => item.id === "native-desktop-build")).status,
    "unavailable",
  );
  assert.deepEqual(requiredFixture(calls.find(([command]) => command === "pkg-config"))[1], [
    "--exists",
    "gtk+-3.0",
    "webkit2gtk-4.1",
    "libsoup-3.0",
  ]);
  assert.ok(!calls.some(([command]) => command === "apt-get"));
});

void test("stale Windows Aqua state is an actionable prerequisite failure", async () => {
  const report = await collectSelectedPrerequisites([{ id: "actionlint" }], {
    platform: "win32",
    readToolState: () => null,
    run: () => ({ status: 0, stdout: "24.21.0" }),
  });
  assert.deepEqual(requiredFixture(report.find((item) => item.id === "aqua-state")), {
    id: "aqua-state",
    status: "unavailable",
    remediation: "./scripts/bootstrap-quality-tools.ps1",
  });
  assert.ok(
    selectedPrerequisites({ id: "conservative-audit" }).includes("complete-audit-prerequisites"),
  );
  assert.ok(selectedPrerequisites({ id: "playnite-contract" }).includes("msbuild"));
  assert.ok(selectedPrerequisites({ id: "playnite-contract" }).includes("windows-host"));
  assert.ok(!selectedPrerequisites({ id: "playnite-contract" }).includes("dotnet"));
});

void test("selected release audit observes the bare PowerShell executable on every executing host", async () => {
  const selected = { id: "conservative-audit", args: ["rust", "release-unit"] };
  assert.ok(selectedPrerequisites(selected, "linux").includes("pwsh"));
  assert.ok(selectedPrerequisites(selected, "win32").includes("pwsh"));
  assert.ok(
    !selectedPrerequisites({ id: "conservative-audit", args: ["rust"] }, "linux").includes("pwsh"),
  );
  const commands: string[] = [];
  const report = await collectSelectedPrerequisites([selected], {
    platform: "linux",
    run: (command) => {
      commands.push(command);
      return command === "pwsh"
        ? { status: null, error: { code: "ENOENT" }, stdout: "" }
        : { status: 0, stdout: "v24.21.0" };
    },
  });
  assert.equal(requiredFixture(report.find((item) => item.id === "pwsh"))?.status, "unavailable");
  assert.ok(commands.includes("pwsh"));
});

void test("selected Linux Rust audit observes the physical fixture socket pathname budget", async () => {
  const prefix = mkdtempSync(path.join(os.tmpdir(), "pcv-socket-"));
  try {
    const long = path.join(prefix, "a".repeat(100));
    const run = async (temporaryDirectory: string, platform = "linux", stages = ["rust"]) =>
      collectSelectedPrerequisites([{ id: "conservative-audit", args: stages }], {
        platform,
        temporaryDirectory,
        run: () => ({ status: 0, stdout: "v24.21.0" }),
      });
    const tooLong = await run(long);
    const socket = requiredFixture(tooLong.find((item) => item.id === "unix-socket-path"));
    assert.equal(socket?.status, "unavailable");
    assert.ok(requiredFixture(socket.observed_bytes) > requiredFixture(socket.maximum_bytes));
    assert.match(requiredFixture(socket.remediation), /shorter.*temporary/i);
    if (process.platform === "linux") {
      const multibyte = await run(path.join(prefix, "é".repeat(45)));
      assert.equal(
        requiredFixture(multibyte.find((item) => item.id === "unix-socket-path"))?.status,
        "unavailable",
      );
    }
    const short = await run(path.parse(prefix).root);
    assert.equal(
      requiredFixture(short.find((item) => item.id === "unix-socket-path"))?.status,
      "ok",
    );
    mkdirSync(long);
    const alias = path.join(prefix, "short-alias");
    symlinkSync(long, alias, process.platform === "win32" ? "junction" : "dir");
    const physical = await run(alias);
    assert.equal(
      requiredFixture(physical.find((item) => item.id === "unix-socket-path"))?.status,
      "unavailable",
    );
    assert.ok(!(await run(long, "win32")).some((item) => item.id === "unix-socket-path"));
    assert.ok(
      !(await run(long, "linux", ["release-unit"])).some((item) => item.id === "unix-socket-path"),
    );
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

void test("selected fixtures retain their actual direct tools and platform deferrals", () => {
  const fixtures = (names: string[], platform: string) =>
    selectedPrerequisites(
      { id: "lint-tool-fixtures", args: ["scripts/lint-tools.integration.mts", ...names] },
      platform,
    );
  assert.ok(fixtures(["actionlint"], "linux").includes("shellcheck"));
  assert.ok(fixtures(["oxlint"], "linux").includes("npm-vite-plus"));
  assert.ok(fixtures(["stylelint"], "linux").includes("npm-stylelint"));
  assert.ok(fixtures(["psscriptanalyzer"], "win32").includes("psscriptanalyzer"));
  assert.ok(!fixtures(["psscriptanalyzer"], "linux").includes("psscriptanalyzer"));
  assert.ok(selectedPrerequisites({ id: "rustfmt" }).includes("rustfmt-component"));
  assert.ok(
    selectedPrerequisites({ id: "rust-clippy:portcove-core" }).includes("clippy-component"),
  );
  assert.throws(() => fixtures(["unowned"], "linux"), /inventory is unavailable/);
});

void test("cache observations never install a missing package manager or Aqua payload", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-prerequisite-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { COREPACK_HOME: path.join(directory, "absent") };
  assert.deepEqual(pnpmDefinition("12.7.0").command, ["pnpm", "--version"]);
  assert.equal(existsSync(environment.COREPACK_HOME), false);
  const calls: string[] = [];
  const results = await collectSelectedPrerequisites([{ id: "oxfmt" }, { id: "actionlint" }], {
    environment: { ...process.env, ...environment },
    pnpmDefinition: () => null,
    aquaDefinition: () => null,
    run: (command) => {
      calls.push(command);
      return { status: 0, stdout: "24.21.0" };
    },
  });
  assert.equal(requiredFixture(results.find((item) => item.id === "pnpm")).status, "unavailable");
  assert.equal(
    requiredFixture(results.find((item) => item.id === "actionlint")).status,
    "unavailable",
  );
  assert.ok(!calls.includes("corepack") && !calls.includes("aqua"));
  assert.equal(existsSync(environment.COREPACK_HOME), false);
});

void test("external pnpm readiness uses its declared command with child-only acquisition guards", () => {
  const definition = pnpmDefinition("12.7.0");
  const environment = Object.freeze({ COREPACK_ENABLE_NETWORK: "1", VP_DUMP_DIRS: "inherited" });
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  const result = probeTool(
    definition,
    (command, args, options) => {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["--version"]);
      childEnvironment = options.env;
      return { status: 0, stdout: "12.8.0", stderr: "" };
    },
    { environment },
  );
  assert.equal(result.status, "mismatch");
  assert.equal(result.observed, "12.8.0");
  assert.equal(childEnvironment?.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(childEnvironment?.VP_DUMP_DIRS, "1");
  assert.deepEqual(environment, { COREPACK_ENABLE_NETWORK: "1", VP_DUMP_DIRS: "inherited" });
});

void test("managed pnpm observation never acquires and checks the resolved payload's actual version", () => {
  const version = "12.14.0";
  const bin = path.join(os.tmpdir(), "viteplus doctor fixture", "bin");
  const vp = path.join(bin, process.platform === "win32" ? "vp.exe" : "vp");
  const payload = path.join(os.tmpdir(), "resolved pnpm payload", "pnpm");
  const manager = { name: "pnpm", version, installed: true, bin_paths: { pnpm: payload } };
  const json = (value: unknown) => JSON.stringify({ package_manager: value });
  const environment = Object.freeze({
    PATH: path.join(os.tmpdir(), "external tools"),
    COREPACK_ENABLE_NETWORK: "1",
    RUSTUP_AUTO_INSTALL: "0",
    VP_DUMP_DIRS: "inherited",
  });
  for (const [scenario, metadata, payloadVersion, expected] of [
    ["cold", json({ ...manager, installed: false }), null, "unavailable"],
    ["malformed", "{", null, "unavailable"],
    [
      "relative payload",
      json({ ...manager, bin_paths: { pnpm: "relative/pnpm" } }),
      null,
      "unavailable",
    ],
    ["warm", json(manager), version, "ok"],
    ["wrong payload version", json(manager), "12.13.0", "mismatch"],
    ["missing payload", json(manager), "missing", "unavailable"],
  ] as const) {
    let acquisitions = 0;
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv; timeout?: number }[] =
      [];
    const result = probeTool(
      pnpmDefinition(version),
      (command, args, options) => {
        calls.push({
          command,
          args,
          ...(options.env ? { env: options.env } : {}),
          ...(options.timeout ? { timeout: options.timeout } : {}),
        });
        if (command === "pnpm") {
          if (options.env?.VP_DUMP_DIRS !== "1") {
            acquisitions += 1;
            return { status: 0, stdout: version };
          }
          return { status: 0, stdout: `layout\tsingle-root\nbin\t${bin}\n` };
        }
        if (command === vp) return { status: 0, stdout: metadata };
        if (command === payload)
          return payloadVersion === "missing"
            ? { status: null, error: { code: "ENOENT" } }
            : { status: 0, stdout: payloadVersion ?? version };
        return { status: 1 };
      },
      { environment },
    );
    assert.equal(result.status, expected, scenario);
    assert.equal(acquisitions, 0, scenario);
    assert.deepEqual(
      calls.map((call) => call.command),
      ["pnpm", vp, ...(payloadVersion === null ? [] : [payload])],
      scenario,
    );
    assert.deepEqual(calls[1]?.args, ["env", "current", "pnpm", "--json"]);
    assert.equal(calls[1]?.env?.VP_DUMP_DIRS, undefined);
    assert.ok(
      calls.every(
        (call) => call.env?.COREPACK_ENABLE_NETWORK === "0" && call.env.RUSTUP_AUTO_INSTALL === "0",
      ),
    );
    assert.ok(
      calls.every(
        (call, index) =>
          (call.timeout ?? 0) > 0 && (call.timeout ?? 0) <= (calls[index - 1]?.timeout ?? 15_000),
      ),
    );
    if (payloadVersion !== null) {
      assert.deepEqual(calls[2]?.args, ["--version"]);
      assert.equal(calls[2]?.env?.PATH?.split(path.delimiter)[0], path.dirname(process.execPath));
    }
    if (expected === "mismatch") assert.equal(result.observed, payloadVersion);
  }
  assert.equal(environment.COREPACK_ENABLE_NETWORK, "1");
  assert.equal(environment.VP_DUMP_DIRS, "inherited");
});

void test("selected and profile observations refuse missing pnpm runtime acquisition and reuse warm runtime", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove pnpm runtime "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = requiredFixture(readToolPins().packageManager.split("@")[1]);
  const installed = directory;
  mkdirSync(path.join(installed, "bin"), { recursive: true });
  const runtime = path.join(installed, "pnpm-native");
  const acquisition = path.join(installed, "acquisition-attempt");
  writeFileSync(
    path.join(installed, "bin/pnpm.mjs"),
    `import {existsSync,writeFileSync} from "node:fs";
if (!existsSync(${JSON.stringify(runtime)})) {
  if (process.env.COREPACK_ENABLE_NETWORK === "0") {
    console.error("pnpm native runtime is missing; explicit setup required");
    process.exit(1);
  }
  writeFileSync(${JSON.stringify(acquisition)}, "ordinary observation attempted acquisition");
}
console.log(${JSON.stringify(version)});
`,
  );
  const shim = path.join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const runtimeScript = path.join(installed, "bin/pnpm.mjs");
  writeFileSync(
    shim,
    process.platform === "win32"
      ? `@"${process.execPath}" "${runtimeScript}" %*\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${runtimeScript}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  const environment = Object.freeze({
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
    ),
    PATH: directory,
    COREPACK_HOME: directory,
    COREPACK_ENABLE_NETWORK: "1",
  });
  const globalNetwork = process.env.COREPACK_ENABLE_NETWORK;
  const { rust } = await loadQualityManifest();
  const options: DoctorOptions = {
    environment,
    frontendDependenciesAvailable: () => true,
    storage: {},
    pnpmDefinition: () => ({ ...pnpmDefinition(version), command: [shim, "--version"] }),
    // Full frontend profiles need the containment compiler; this pnpm-only
    // acquisition fixture observes a declared compiler without provisioning it.
    run(command, args, options) {
      assert.equal(options.env?.RUSTUP_AUTO_INSTALL, "0");
      if (command === "rustc") {
        assert.deepEqual(args, ["--version"]);
        return { status: 0, stdout: `rustc ${rust.channel}` };
      }
      return spawnCommand(command, args, options);
    },
  };
  for (const warm of [false, true]) {
    if (warm) writeFileSync(runtime, "verified warm fixture");
    const selected = await collectSelectedPrerequisites([{ id: "oxfmt" }], options);
    const profile = await collectProfileDoctor("frontend", options);
    for (const tools of [selected, profile.tools]) {
      const pnpm = requiredFixture(tools.find((tool) => tool.id === "pnpm"));
      assert.equal(pnpm.status, warm ? "ok" : "unavailable");
      if (!warm) assert.match(requiredFixture(pnpm.remediation), /repository-pinned pnpm/u);
      assert.equal(requiredFixture(tools.find((tool) => tool.id === "node")).status, "ok");
    }
    assert.equal(profile.ok, warm, JSON.stringify(profile));
    assert.equal(existsSync(acquisition), false);
    assert.equal(existsSync(runtime), warm);
    assert.equal(environment.COREPACK_ENABLE_NETWORK, "1");
    assert.equal(process.env.COREPACK_ENABLE_NETWORK, globalNetwork);
  }
});

void test("Aqua observations use an existing unique payload and reject ambiguous or missing caches", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-cached-aqua-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const definition = {
    id: "actionlint",
    version: "1.7.12",
    cachePackage: "rhysd/actionlint",
    cacheVersion: "v1.7.12",
  };
  assert.equal(existingAquaDefinition(definition, directory, "linux"), null);
  const versionRoot = path.join(
    directory,
    "pkgs/github_release/github.com/rhysd/actionlint/v1.7.12",
  );
  mkdirSync(path.join(versionRoot, "archive"), { recursive: true });
  writeFileSync(path.join(versionRoot, "archive/actionlint"), "existing fixture");
  assert.deepEqual(
    requiredFixture(existingAquaDefinition(definition, directory, "linux")).command,
    [path.join(versionRoot, "archive/actionlint"), "-version"],
  );
  mkdirSync(path.join(versionRoot, "other"));
  writeFileSync(path.join(versionRoot, "other/actionlint"), "ambiguous fixture");
  assert.equal(existingAquaDefinition(definition, directory, "linux"), null);
});

const definition: ToolDefinition = {
  id: "example",
  command: ["example", "--version"],
  version: "1.2.3",
};

void test("stale npm fixture tools cannot approve their own installed version", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-npm-prerequisite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ devDependencies: { oxfmt: "0.70.0" } }),
  );
  const packageRoot = path.join(directory, "node_modules/oxfmt");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "cli.mjs"), "console.log('0.69.0');");
  const marker = path.join(packageRoot, "package.json");
  writeFileSync(
    marker,
    JSON.stringify({ name: "oxfmt", version: "0.69.0", bin: { oxfmt: "cli.mjs" } }),
  );
  const definition = existingNpmDefinition("npm-vite-plus", directory, "oxfmt", "oxfmt");
  assert.ok(definition);
  assert.equal(definition.version, "0.70.0");
  assert.equal(definition.installed_version, "0.69.0");
  assert.equal(probeTool(definition, () => ({ status: 0, stdout: "0.69.0" })).status, "mismatch");
  writeFileSync(
    marker,
    JSON.stringify({ name: "wrong-package", version: "0.70.0", bin: { oxfmt: "cli.mjs" } }),
  );
  assert.equal(existingNpmDefinition("npm-vite-plus", directory, "oxfmt", "oxfmt"), null);
});
void test("tsgolint observes installed metadata only after successful help startup", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-tsgolint-prerequisite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ devDependencies: { "oxlint-tsgolint": "7.0.2003" } }),
  );
  const packageRoot = path.join(directory, "node_modules/oxlint-tsgolint");
  mkdirSync(packageRoot, { recursive: true });
  const executable = path.join(packageRoot, "cli.cjs");
  writeFileSync(executable, "throw new Error('fixture must not execute');");
  const marker = path.join(packageRoot, "package.json");
  const metadata = { name: "oxlint-tsgolint", version: "7.0.2003", bin: { tsgolint: "cli.cjs" } };
  const writeMetadata = (value: unknown) => writeFileSync(marker, JSON.stringify(value));
  const readDefinition = () =>
    existingNpmDefinition("npm-vite-plus", directory, "oxlint-tsgolint", "tsgolint");
  writeMetadata(metadata);
  const definition = readDefinition();
  assert.ok(definition);
  assert.deepEqual(definition.command, [process.execPath, executable, "--help"]);
  const calls: [string, string[]][] = [];
  const result = probeTool(definition, (command, args) => {
    calls.push([command, args]);
    return { status: 0, stderr: "Usage: tsgolint; incidental 1.2.3 SECRET" };
  });
  assert.deepEqual(calls, [[process.execPath, [executable, "--help"]]]);
  assert.equal(result.status, "ok");
  assert.equal(result.observed, "7.0.2003");
  assert.equal(result.expected, "7.0.2003");
  assert.equal(result.version_source, "installed-package");
  assert.ok(!JSON.stringify(result).includes("SECRET"));

  writeMetadata({ ...metadata, version: "7.0.2002" });
  const stale = probeTool(requiredFixture(readDefinition()), () => ({
    status: 0,
    stdout: "7.0.2003",
  }));
  assert.equal(stale.status, "mismatch");
  assert.equal(stale.observed, "7.0.2002");
  for (const failure of [
    { status: 2, stderr: "SECRET startup failure" },
    { status: null, error: { code: "ENOENT" } },
    { status: null, error: { code: "ETIMEDOUT" } },
  ]) {
    const failed = probeTool(definition, () => failure);
    assert.equal(failed.status, failure.error?.code === "ETIMEDOUT" ? "timeout" : "unavailable");
    assert.ok(!JSON.stringify(failed).includes("SECRET"));
  }
  for (const code of ["ENOENT", "ETIMEDOUT"]) {
    const failed = probeTool(definition, () => {
      throw Object.assign(new Error("SECRET"), { code });
    });
    assert.equal(failed.status, code === "ETIMEDOUT" ? "timeout" : "unavailable");
    assert.equal(failed.observed, null);
    assert.ok(!JSON.stringify(failed).includes("SECRET"));
  }
  for (const invalid of [
    { ...metadata, name: "wrong-package" },
    { ...metadata, version: undefined },
    { ...metadata, version: "invalid" },
    { ...metadata, bin: { tsgolint: "missing.cjs" } },
    { ...metadata, bin: { tsgolint: "." } },
    { ...metadata, bin: { tsgolint: "../../outside.cjs" } },
  ]) {
    writeMetadata(invalid);
    assert.equal(readDefinition(), null);
  }
  writeFileSync(marker, "malformed json");
  assert.equal(readDefinition(), null);
  rmSync(marker);
  assert.equal(readDefinition(), null);
  writeMetadata(metadata);
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ devDependencies: { "oxlint-tsgolint": "^7.0.2003" } }),
  );
  assert.equal(readDefinition(), null);
});

void test("tsgolint refuses a launcher symlink outside its installed package", (t) => {
  if (process.platform === "win32") return t.skip("file symlinks require Windows privilege");
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-tsgolint-linked-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageRoot = path.join(directory, "node_modules/oxlint-tsgolint");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ devDependencies: { "oxlint-tsgolint": "7.0.2003" } }),
  );
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "oxlint-tsgolint", version: "7.0.2003", bin: "cli.cjs" }),
  );
  const outside = path.join(directory, "outside.cjs");
  writeFileSync(outside, "");
  symlinkSync(outside, path.join(packageRoot, "cli.cjs"));
  assert.equal(
    existingNpmDefinition("npm-vite-plus", directory, "oxlint-tsgolint", "tsgolint"),
    null,
  );
});

void test("doctor distinguishes exact, mismatched, failed and absent tools without raw output", () => {
  const run = (stdout: string) => () => ({ status: 0, stdout });
  assert.equal(probeTool(definition, run("example 1.2.3")).status, "ok");
  assert.equal(probeTool(definition, run("v1.2.3")).status, "ok");
  assert.equal(probeTool(definition, run("example 1.2.30")).status, "mismatch");
  assert.equal(probeTool(definition, () => ({ status: 1, stdout: "1.2.3" })).status, "unavailable");
  const missing = probeTool(definition, () => {
    throw Object.assign(new Error("SECRET"), { code: "ENOENT" });
  });
  assert.equal(missing.status, "unavailable");
  assert.ok(!JSON.stringify(missing).includes("SECRET"));
});
void test("doctor reports a timeout rather than a version pass", () => {
  assert.equal(
    probeTool(definition, () => ({
      status: null,
      error: { code: "ETIMEDOUT" },
      stdout: "1.2.3",
    })).status,
    "timeout",
  );
});

void test("Core profile observes only Rust capabilities; missing frontend cannot block it", async () => {
  for (const platform of ["linux", "win32"]) {
    const commands: [string, string[]][] = [];
    const report = await collectProfileDoctor("core", {
      platform,
      storage: {},
      pnpmDefinition: () => null,
      aquaDefinition: () => null,
      run(command, args, options) {
        commands.push([command, args]);
        assert.equal(options.env?.RUSTUP_AUTO_INSTALL, "0");
        assert.equal(options.env?.COREPACK_ENABLE_NETWORK, "0");
        if (command === "rustc") return { status: 0, stdout: "rustc 1.99.1" };
        if (args[0] === "nextest" || path.basename(command) === "cargo-nextest.exe")
          return { status: 0, stdout: "cargo-nextest 0.9.100" };
        return { status: 0, stdout: "1.99.1" };
      },
    });
    assert.equal(report.ok, true);
    assert.ok(
      commands.every(
        ([command]) =>
          command === "rustc" ||
          command === "cargo" ||
          (platform === "win32" && path.basename(command) === "cargo-nextest.exe"),
      ),
    );
    assert.ok(!report.capabilities.includes("node"));
    assert.ok(!report.capabilities.includes("frontend-dependencies"));
  }
});

void test("requested profile stays failed when one capability is missing; observations never provision", async () => {
  const commands: [string, string[]][] = [];
  const report = await collectProfileDoctor("frontend", {
    storage: {},
    pnpmDefinition: () => null,
    run(command, args, options) {
      commands.push([command, args]);
      assert.equal(options.env?.RUSTUP_AUTO_INSTALL, "0");
      return {
        status: 0,
        stdout:
          command === "rustc"
            ? "1.98.1"
            : readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
      };
    },
  });
  assert.equal(report.ok, false);
  assert.equal(
    requiredFixture(report.tools.find((tool) => tool.id === "pnpm")).status,
    "unavailable",
  );
  assert.equal(requiredFixture(report.tools.find((tool) => tool.id === "node")).status, "ok");
  assert.deepEqual(
    commands.map(([command]) => command),
    [process.execPath, ...(["linux", "win32"].includes(process.platform) ? ["rustc"] : [])],
  );
});

void test("native Windows profile observes installed compiler paths while ordinary validation stays unverified", async () => {
  const { developmentCapabilityPlan } = await import("./development-capabilities.mts");
  const { readFileSync } = await import("node:fs");
  const plan = await developmentCapabilityPlan("native-desktop", { platform: "win32" });
  const quality = await loadQualityManifest();
  const pssa = readFileSync(
    new URL("../.config/powershell-resources.psd1", import.meta.url),
    "utf8",
  ).match(/version\s*=\s*'([^']+)'/u)?.[1];
  const calls: [string, string[]][] = [];
  const options: DoctorOptions = {
    platform: "win32",
    storage: {},
    readToolState: () => ({
      desktop: {
        tauri_driver_version: requiredFixture(readToolPins().bootstrap.desktop).tauri_driver,
        webview2_version: "100.0.0.1",
      },
    }),
    frontendDependenciesAvailable: () => true,
    desktopDrivers: () => ({
      driver: "/verified/tauri-driver",
      nativeDriver: "/verified/msedgedriver",
    }),
    pnpmDefinition: (version) => ({ id: "pnpm", version, command: ["cached-pnpm", "--version"] }),
    aquaDefinition: (definition) => ({ ...definition, command: [definition.id, "--version"] }),
    run(command, args) {
      calls.push([command, args]);
      if (command === "/verified/msedgedriver") return { status: 0, stdout: "100.0.0.1" };
      const tool = quality.tools.find(
        (tool) =>
          JSON.stringify(tool.command) === JSON.stringify([command, ...args]) ||
          JSON.stringify(cachedRustDefinition(tool, toolCachePaths(), "win32").command) ===
            JSON.stringify([command, ...args]),
      );
      const version =
        tool?.version ??
        (command === "rustc"
          ? plan.pins.rust
          : command === "cached-pnpm"
            ? plan.pins.package_manager.split("@")[1]
            : command === "aqua"
              ? readFileSync(new URL("../.aqua-version", import.meta.url), "utf8")
                  .trim()
                  .replace(/^v/u, "")
              : command === "pwsh" && args.join(" ").includes("Import-Module")
                ? pssa
                : command === "pwsh"
                  ? "7.6.6"
                  : plan.pins.node);
      if (["ruff", "shellcheck", "actionlint"].includes(command)) {
        const pin = readFileSync(new URL("../aqua.yaml", import.meta.url), "utf8")
          .match(new RegExp(`(?:ruff|shellcheck|actionlint)@([^\\s]+)`, "g"))
          ?.find((value: string) => value.startsWith(command + "@"));
        return {
          status: 0,
          stdout: requiredFixture(requiredFixture(pin).split("@")[1]).replace(/^v/u, ""),
        };
      }
      return { status: 0, stdout: version };
    },
  };
  const report = await collectProfileDoctor("native-desktop", options);
  assert.equal(report.ok, true, JSON.stringify(report.tools));
  assert.equal(
    requiredFixture(report.tools.find((tool) => tool.id === "native-desktop-build")).status,
    "ok",
  );
  assert.match(
    requiredFixture(
      requiredFixture(report.tools.find((tool) => tool.id === "native-desktop-build"))
        .interpretation,
    ),
    /presence only/,
  );
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "pwsh" &&
        args.join(" ").includes("Microsoft.VisualStudio.Component.VC.Tools.x86.x64"),
    ),
  );
  const legacy = await collectSelectedPrerequisites(
    [{ id: "rust-clippy:portcove-desktop" }],
    options,
  );
  assert.equal(
    requiredFixture(legacy.find((tool) => tool.id === "native-desktop-build")).status,
    "unverified",
  );
});

void test("Linux native PATH help cannot approve unverified driver identity", async () => {
  const commands: string[] = [];
  const report = await collectProfileDoctor("native-desktop", {
    platform: "linux",
    storage: {},
    run(command) {
      commands.push(command);
      return { status: 0, stdout: "24.21.0" };
    },
  });
  for (const id of ["tauri-driver", "native-driver"])
    assert.equal(requiredFixture(report.tools.find((tool) => tool.id === id)).status, "unverified");
  assert.equal(report.ok, false);
  assert.ok(!commands.includes("tauri-driver") && !commands.includes("WebKitWebDriver"));
});

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "expected fixture entry is missing");
  return value;
}

void test("a cached Windows native driver cannot pass with an unknown WebView version binding", async () => {
  const pin = requiredFixture(readToolPins().bootstrap.desktop).tauri_driver;
  for (const webview2_version of [undefined, null, "", "100.0.0", " 100.0.0.1", 42, {}]) {
    let launches = 0;
    const observations = await collectSelectedPrerequisites([], {
      platform: "win32",
      capabilities: ["native-driver"],
      readToolState: () => ({ desktop: { tauri_driver_version: pin, webview2_version } }),
      desktopDrivers: () => ({
        driver: "/fixture/tauri-driver",
        nativeDriver: "/fixture/msedgedriver",
      }),
      run: () => {
        launches++;
        return { status: 0, stdout: "100.0.0.1" };
      },
    });
    assert.equal(requiredFixture(observations[0]).status, "unavailable");
    assert.equal(launches, 0, "unbound driver must not be probed as a qualified prerequisite");
  }
});
