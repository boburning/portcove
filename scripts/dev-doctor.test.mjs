import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  probeTool,
  selectedPrerequisites,
  collectSelectedPrerequisites,
  existingPnpmDefinition,
  existingAquaDefinition,
} from "./dev-doctor.mjs";

test("selected frontend prerequisites do not invoke Rust, native provisioning or bootstrap", async () => {
  const calls = [];
  const report = await collectSelectedPrerequisites([{ id: "oxfmt" }], {
    pnpmDefinition: (version) => ({ id: "pnpm", version, command: ["cached-pnpm", "--version"] }),
    run: (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.env.RUSTUP_AUTO_INSTALL, "0");
      return { status: 0, stdout: command === "cached-pnpm" ? "12.7.0" : "v24.21.0" };
    },
  });
  assert.deepEqual(
    report.map((entry) => entry.id),
    ["node", "pnpm", "frontend-dependencies"],
  );
  assert.equal(calls.length, 2);
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

const definition = {
  id: "example",
  command: ["example", "--version"],
  version: "1.2.3",
};
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
