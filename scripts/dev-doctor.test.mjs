import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeTool,
  selectedPrerequisites,
  collectSelectedPrerequisites,
  existingPnpmDefinition,
  existingAquaDefinition,
  existingNpmDefinition,
} from "./dev-doctor.mjs";

test("selected frontend prerequisites do not invoke Rust, native provisioning or bootstrap", async () => {
  const calls = [];
  let pnpmVersion;
  const report = await collectSelectedPrerequisites([{ id: "oxfmt" }], {
    pnpmDefinition: (version) => {
      pnpmVersion = version;
      return { id: "pnpm", version, command: ["cached-pnpm", "--version"] };
    },
    run: (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.env.RUSTUP_AUTO_INSTALL, "0");
      return { status: 0, stdout: command === "cached-pnpm" ? pnpmVersion : "v24.21.0" };
    },
  });
  assert.deepEqual(
    report.map((entry) => entry.id),
    ["node", "pnpm", "frontend-dependencies"],
  );
  assert.equal(calls.length, 2);
  assert.equal(report.find((entry) => entry.id === "pnpm").status, "ok");
  assert.ok(calls.every(([command]) => command !== "cargo" && command !== "rustc"));
});

test("selected native compilation reports missing Linux libraries without installing them", async () => {
  const calls = [];
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
  assert.equal(report.find((item) => item.id === "native-desktop-build").status, "unavailable");
  assert.deepEqual(calls.find(([command]) => command === "pkg-config")[1], [
    "--exists",
    "gtk+-3.0",
    "webkit2gtk-4.1",
    "libsoup-3.0",
  ]);
  assert.ok(!calls.some(([command]) => command === "apt-get"));
});

test("stale Windows Aqua state is an actionable prerequisite failure", async () => {
  const report = await collectSelectedPrerequisites([{ id: "actionlint" }], {
    platform: "win32",
    readToolState: () => null,
    run: () => ({ status: 0, stdout: "24.21.0" }),
  });
  assert.deepEqual(
    report.find((item) => item.id === "aqua-state"),
    {
      id: "aqua-state",
      status: "unavailable",
      remediation: "./scripts/bootstrap-quality-tools.ps1",
    },
  );
  assert.ok(
    selectedPrerequisites({ id: "conservative-audit" }).includes("complete-audit-prerequisites"),
  );
  assert.ok(selectedPrerequisites({ id: "playnite-contract" }).includes("msbuild"));
  assert.ok(selectedPrerequisites({ id: "playnite-contract" }).includes("windows-host"));
  assert.ok(!selectedPrerequisites({ id: "playnite-contract" }).includes("dotnet"));
});

test("selected release audit observes the bare PowerShell executable on every executing host", async () => {
  const selected = { id: "conservative-audit", args: ["rust", "release-unit"] };
  assert.ok(selectedPrerequisites(selected, "linux").includes("pwsh"));
  assert.ok(selectedPrerequisites(selected, "win32").includes("pwsh"));
  assert.ok(
    !selectedPrerequisites({ id: "conservative-audit", args: ["rust"] }, "linux").includes("pwsh"),
  );
  const commands = [];
  const report = await collectSelectedPrerequisites([selected], {
    platform: "linux",
    run: (command) => {
      commands.push(command);
      return command === "pwsh"
        ? { status: null, error: { code: "ENOENT" }, stdout: "" }
        : { status: 0, stdout: "v24.21.0" };
    },
  });
  assert.equal(report.find((item) => item.id === "pwsh")?.status, "unavailable");
  assert.ok(commands.includes("pwsh"));
});

test("selected Linux Rust audit observes the physical fixture socket pathname budget", async () => {
  const prefix = mkdtempSync(path.join(os.tmpdir(), "pcv-socket-"));
  try {
    const long = path.join(prefix, "a".repeat(100));
    const run = async (temporaryDirectory, platform = "linux", stages = ["rust"]) =>
      collectSelectedPrerequisites([{ id: "conservative-audit", args: stages }], {
        platform,
        temporaryDirectory,
        run: () => ({ status: 0, stdout: "v24.21.0" }),
      });
    const tooLong = await run(long);
    const socket = tooLong.find((item) => item.id === "unix-socket-path");
    assert.equal(socket?.status, "unavailable");
    assert.ok(socket.observed_bytes > socket.maximum_bytes);
    assert.match(socket.remediation, /shorter.*temporary/i);
    if (process.platform === "linux") {
      const multibyte = await run(path.join(prefix, "é".repeat(45)));
      assert.equal(multibyte.find((item) => item.id === "unix-socket-path")?.status, "unavailable");
    }
    const short = await run(path.parse(prefix).root);
    assert.equal(short.find((item) => item.id === "unix-socket-path")?.status, "ok");
    mkdirSync(long);
    const alias = path.join(prefix, "short-alias");
    symlinkSync(long, alias, process.platform === "win32" ? "junction" : "dir");
    const physical = await run(alias);
    assert.equal(physical.find((item) => item.id === "unix-socket-path")?.status, "unavailable");
    assert.ok(!(await run(long, "win32")).some((item) => item.id === "unix-socket-path"));
    assert.ok(
      !(await run(long, "linux", ["release-unit"])).some((item) => item.id === "unix-socket-path"),
    );
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("selected fixtures retain their actual direct tools and platform deferrals", () => {
  const fixtures = (names, platform) =>
    selectedPrerequisites(
      { id: "lint-tool-fixtures", args: ["scripts/lint-tools.integration.mjs", ...names] },
      platform,
    );
  assert.ok(fixtures(["actionlint"], "linux").includes("shellcheck"));
  assert.ok(fixtures(["oxlint"], "linux").includes("npm-oxlint-tsgolint"));
  assert.ok(fixtures(["stylelint"], "linux").includes("npm-stylelint"));
  assert.ok(fixtures(["psscriptanalyzer"], "win32").includes("psscriptanalyzer"));
  assert.ok(!fixtures(["psscriptanalyzer"], "linux").includes("psscriptanalyzer"));
  assert.ok(selectedPrerequisites({ id: "rustfmt" }).includes("rustfmt-component"));
  assert.ok(
    selectedPrerequisites({ id: "rust-clippy:portcove-core" }).includes("clippy-component"),
  );
  assert.throws(() => fixtures(["unowned"], "linux"), /inventory is unavailable/);
});

test("cache observations never install a missing package manager or Aqua payload", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-prerequisite-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { COREPACK_HOME: path.join(directory, "absent") };
  assert.equal(existingPnpmDefinition("12.7.0", environment), null);
  assert.equal(existsSync(environment.COREPACK_HOME), false);
  const calls = [];
  const results = await collectSelectedPrerequisites([{ id: "oxfmt" }, { id: "actionlint" }], {
    environment: { ...process.env, ...environment },
    pnpmDefinition: () => null,
    aquaDefinition: () => null,
    run: (command) => {
      calls.push(command);
      return { status: 0, stdout: "24.21.0" };
    },
  });
  assert.equal(results.find((item) => item.id === "pnpm").status, "unavailable");
  assert.equal(results.find((item) => item.id === "actionlint").status, "unavailable");
  assert.ok(!calls.includes("corepack") && !calls.includes("aqua"));
  assert.equal(existsSync(environment.COREPACK_HOME), false);
});

test("cached package-manager observations require exact identity and contained regular entrypoint", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-cached-pnpm-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const installed = path.join(directory, "v1/pnpm/12.7.0");
  mkdirSync(path.join(installed, "bin"), { recursive: true });
  writeFileSync(path.join(installed, "bin/pnpm.mjs"), "console.log('12.7.0');\n");
  const marker = path.join(installed, ".corepack");
  const metadata = {
    locator: { name: "pnpm", reference: "12.7.0" },
    bin: { pnpm: "bin/pnpm.mjs" },
  };
  writeFileSync(marker, JSON.stringify(metadata));
  const definition = existingPnpmDefinition("12.7.0", { COREPACK_HOME: directory });
  assert.equal(definition.command[0], process.execPath);
  assert.ok(!definition.command.includes("corepack"));
  writeFileSync(
    marker,
    JSON.stringify({ ...metadata, locator: { name: "pnpm", reference: "12.8.0" } }),
  );
  assert.equal(existingPnpmDefinition("12.7.0", { COREPACK_HOME: directory }), null);
  writeFileSync(path.join(directory, "outside.mjs"), "throw Error('must not execute');");
  writeFileSync(marker, JSON.stringify({ ...metadata, bin: { pnpm: "../../../outside.mjs" } }));
  assert.equal(existingPnpmDefinition("12.7.0", { COREPACK_HOME: directory }), null);
});

test("Aqua observations use an existing unique payload and reject ambiguous or missing caches", (t) => {
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
  assert.deepEqual(existingAquaDefinition(definition, directory, "linux").command, [
    path.join(versionRoot, "archive/actionlint"),
    "-version",
  ]);
  mkdirSync(path.join(versionRoot, "other"));
  writeFileSync(path.join(versionRoot, "other/actionlint"), "ambiguous fixture");
  assert.equal(existingAquaDefinition(definition, directory, "linux"), null);
});

test("a linked Corepack version cannot execute an entrypoint outside the configured cache", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-linked-pnpm-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cache = path.join(directory, "cache"),
    foreign = path.join(directory, "foreign");
  mkdirSync(path.join(cache, "v1/pnpm"), { recursive: true });
  mkdirSync(path.join(foreign, "bin"), { recursive: true });
  writeFileSync(path.join(foreign, "bin/pnpm.mjs"), "throw Error('must not execute');");
  writeFileSync(
    path.join(foreign, ".corepack"),
    JSON.stringify({
      locator: { name: "pnpm", reference: "12.7.0" },
      bin: { pnpm: "bin/pnpm.mjs" },
    }),
  );
  symlinkSync(
    foreign,
    path.join(cache, "v1/pnpm/12.7.0"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(existingPnpmDefinition("12.7.0", { COREPACK_HOME: cache }), null);
});

const definition = {
  id: "example",
  command: ["example", "--version"],
  version: "1.2.3",
};

test("stale npm fixture tools cannot approve their own installed version", (t) => {
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
  const definition = existingNpmDefinition("npm-oxfmt", directory, "oxfmt", "oxfmt");
  assert.equal(definition.version, "0.70.0");
  assert.equal(definition.installed_version, "0.69.0");
  assert.equal(probeTool(definition, () => ({ status: 0, stdout: "0.69.0" })).status, "mismatch");
  writeFileSync(
    marker,
    JSON.stringify({ name: "wrong-package", version: "0.70.0", bin: { oxfmt: "cli.mjs" } }),
  );
  assert.equal(existingNpmDefinition("npm-oxfmt", directory, "oxfmt", "oxfmt"), null);
});
test("tsgolint observes installed metadata only after successful help startup", (t) => {
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
  const writeMetadata = (value) => writeFileSync(marker, JSON.stringify(value));
  const readDefinition = () =>
    existingNpmDefinition("npm-oxlint-tsgolint", directory, "oxlint-tsgolint", "tsgolint");
  writeMetadata(metadata);
  const definition = readDefinition();
  assert.deepEqual(definition.command, [process.execPath, executable, "--help"]);
  const calls = [];
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
  const stale = probeTool(readDefinition(), () => ({ status: 0, stdout: "7.0.2003" }));
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

test("tsgolint refuses a launcher symlink outside its installed package", (t) => {
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
    existingNpmDefinition("npm-oxlint-tsgolint", directory, "oxlint-tsgolint", "tsgolint"),
    null,
  );
});

test("doctor distinguishes exact, mismatched, failed and absent tools without raw output", () => {
  const run = (stdout) => () => ({ status: 0, stdout });
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
test("doctor reports a timeout rather than a version pass", () => {
  assert.equal(
    probeTool(definition, () => ({
      status: null,
      error: { code: "ETIMEDOUT" },
      stdout: "1.2.3",
    })).status,
    "timeout",
  );
});
