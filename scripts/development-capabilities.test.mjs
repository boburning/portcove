import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  developmentCapabilityPlan,
  profileCapabilities,
  validationCapabilities,
} from "./development-capabilities.mjs";
import { selectedPrerequisites } from "./dev-doctor.mjs";

test("frontend and direct Core inventories are independent; daily and native are additive", async () => {
  const frontend = await developmentCapabilityPlan("frontend");
  const core = await developmentCapabilityPlan("core");
  const daily = await developmentCapabilityPlan("daily");
  const native = await developmentCapabilityPlan("native-desktop");
  assert.deepEqual(frontend.capabilities, ["node", "pnpm", "frontend-dependencies"]);
  assert.deepEqual(core.capabilities, [
    "rustc",
    "cargo",
    "rustfmt-component",
    "clippy-component",
    "cargo-nextest",
  ]);
  assert.deepEqual(
    core.setup.cargo_tools.map((tool) => tool.id),
    ["cargo-nextest"],
  );
  assert.equal(core.setup.frontend, false);
  assert.equal(core.setup.aqua, false);
  assert.equal(frontend.setup.rust, false);
  assert.equal(frontend.setup.aqua, false);
  assert.equal(frontend.setup.cargo_tools.length, 0);
  for (const capability of [...frontend.capabilities, ...core.capabilities])
    assert.ok(daily.capabilities.includes(capability));
  for (const capability of daily.capabilities) assert.ok(native.capabilities.includes(capability));
  assert.ok(!daily.capabilities.includes("native-desktop-build"));
  assert.ok(native.capabilities.includes("native-desktop-build"));
  assert.equal(
    core.pins.node,
    readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
  );
  assert.throws(() => profileCapabilities("unknown"), /unknown development profile/);
});

test("validation consumers share the exact mapping and keep Node wrappers and fixture subsets", () => {
  assert.equal(selectedPrerequisites, validationCapabilities);
  assert.deepEqual(selectedPrerequisites({ id: "rust-tests:portcove-core" }), [
    "node",
    "rustc",
    "cargo",
    "cargo-nextest",
  ]);
  assert.deepEqual(
    selectedPrerequisites({
      id: "lint-tool-fixtures",
      args: ["scripts/lint-tool-fixtures.mjs", "oxfmt"],
    }),
    ["node", "npm-oxfmt"],
  );
  assert.deepEqual(
    selectedPrerequisites({
      id: "lint-tool-fixtures",
      args: ["scripts/lint-tool-fixtures.mjs", "shellcheck"],
    }),
    ["node", "shellcheck", "aqua-state"],
  );
  assert.throws(
    () => selectedPrerequisites({ id: "lint-tool-fixtures", args: ["tool.mjs", "unknown"] }),
    /inventory is unavailable/,
  );
  assert.ok(
    selectedPrerequisites(
      { id: "conservative-audit", args: ["rust", "release-unit"] },
      "linux",
    ).includes("pwsh"),
  );
  assert.ok(selectedPrerequisites({ id: "playnite-contract" }, "linux").includes("windows-host"));
});

function bootstrapFixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove capability spaces "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, "checkout with spaces");
  const bin = path.join(directory, "commands");
  const root = fileURLToPath(new URL("..", import.meta.url));
  mkdirSync(bin, { recursive: true });
  for (const name of [
    "scripts/development-capabilities.mjs",
    "scripts/quality-tools.mjs",
    "scripts/tool-cache.mjs",
    "scripts/bootstrap-quality-tools.sh",
    "scripts/bootstrap-quality-tools.ps1",
    ".node-version",
    "rust-toolchain.toml",
    "package.json",
    ".github/quality-tools.json",
    ".config/tool-bootstrap.json",
    ".aqua-version",
    "aqua.yaml",
    "aqua-checksums.json",
  ]) {
    const destination = path.join(project, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, name), destination);
  }
  const log = path.join(directory, "calls.jsonl");
  const marker = path.join(project, "work/tool-bin/tool-state.json");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "verified prior state\n");
  const stub = path.join(directory, "stub.mjs");
  writeFileSync(
    stub,
    `import {appendFileSync,readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";
const [command,...args]=process.argv.slice(2);
const log=x=>appendFileSync(process.env.PCV_TEST_LOG,JSON.stringify(x)+"\\n");
if(command==="node") {
 if(path.basename(args[0]??"")==="dev-doctor.mjs") {log(["doctor",...args.slice(1)]);process.exit(0)}
 const result=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:"inherit",env:process.env});process.exit(result.status??1);
}
log([command,...args]);
const manifest=JSON.parse(readFileSync(".github/quality-tools.json","utf8"));
if(command==="corepack") process.exit(process.cwd()===process.env.PCV_TEST_PROJECT?0:94);
if(command==="rustc") {if(process.env.PCV_TEST_MISSING_RUST)process.exit(1);console.log("rustc "+manifest.rust.channel+" (fixture)");process.exit(0)}
if(command==="cargo") {console.log(args[0]==="nextest"?"cargo-nextest "+manifest.tools.find(t=>t.id==="cargo-nextest").version:"fixture component");process.exit(0)}
process.exit(73);
`,
  );
  for (const command of ["node", "corepack", "rustc", "cargo", "rustup", "aqua"]) {
    const name = path.join(bin, command + (process.platform === "win32" ? ".cmd" : ""));
    const text =
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${stub}" ${command} %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${stub.replaceAll("'", "'\\''")}' ${command} "$@"\n`;
    writeFileSync(name, text);
    chmodSync(name, 0o755);
  }
  return {
    project,
    caller: directory,
    marker,
    run(command, args, extra = {}, cwd = project) {
      return spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: 15000,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          PCV_TEST_LOG: log,
          PCV_TEST_PROJECT: project,
          PORTCOVE_SHARED_TOOL_CACHE: path.join(directory, "cache/portcove"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          LOCALAPPDATA: path.join(directory, "cache"),
          ...extra,
        },
      });
    },
    calls() {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

test(
  "POSIX frontend setup in a space-bearing checkout never probes Rust or Aqua",
  { skip: process.platform === "win32" },
  (t) => {
    const fixture = bootstrapFixture(t);
    const result = fixture.run("bash", [
      "scripts/bootstrap-quality-tools.sh",
      "--profile",
      "frontend",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const calls = fixture.calls();
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["corepack", "doctor"],
    );
    assert.deepEqual(calls[0].slice(-3), [
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).packageManager,
      "install",
      "--frozen-lockfile",
    ]);
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);

test(
  "POSIX Core warm setup selects only nextest; failed Rust acquisition preserves prior state",
  { skip: process.platform === "win32" },
  (t) => {
    const fixture = bootstrapFixture(t);
    const result = fixture.run("bash", ["scripts/bootstrap-quality-tools.sh", "--profile", "core"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(fixture.calls().every((call) => ["rustc", "cargo", "doctor"].includes(call[0])));
    assert.ok(fixture.calls().some((call) => call[0] === "cargo" && call[1] === "nextest"));
    const failed = fixture.run(
      "bash",
      ["scripts/bootstrap-quality-tools.sh", "--profile", "core"],
      { PCV_TEST_MISSING_RUST: "1" },
    );
    assert.equal(failed.status, 73, failed.stderr);
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
    assert.ok(!fixture.calls().some((call) => ["aqua", "corepack"].includes(call[0])));
  },
);

test(
  "PowerShell frontend setup selects dependencies before unrelated tools",
  { skip: spawnSync("pwsh", ["--version"], { timeout: 5000 }).status !== 0 },
  (t) => {
    const fixture = bootstrapFixture(t);
    const result = fixture.run(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.join(fixture.project, "scripts/bootstrap-quality-tools.ps1"),
        "-Profile",
        "frontend",
      ],
      {},
      fixture.caller,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      fixture.calls().map((call) => call[0]),
      ["corepack", "doctor"],
    );
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);

test(
  "frontend pin drift fails before dependency acquisition and preserves previous state",
  { skip: process.platform === "win32" },
  (t) => {
    const fixture = bootstrapFixture(t);
    writeFileSync(path.join(fixture.project, ".node-version"), "0.0.1\n");
    const result = fixture.run("bash", [
      "scripts/bootstrap-quality-tools.sh",
      "--profile",
      "frontend",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node 0\.0\.1 is required/);
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);
