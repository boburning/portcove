import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  realpathSync,
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
import type { TestContext } from "node:test";
import {
  developmentCapabilityPlan,
  profileCapabilities,
  validationCapabilities,
} from "./development-capabilities.mts";
import { selectedPrerequisites } from "./dev-doctor.mts";

void test("frontend and direct Core inventories are independent; daily and native are additive", async () => {
  const frontend = await developmentCapabilityPlan("frontend");
  const core = await developmentCapabilityPlan("core");
  const daily = await developmentCapabilityPlan("daily");
  const native = await developmentCapabilityPlan("native-desktop");
  assert.deepEqual(frontend.capabilities, profileCapabilities("frontend"));
  assert.deepEqual(profileCapabilities("frontend", { platform: "darwin" }), [
    "node",
    "pnpm",
    "frontend-dependencies",
  ]);
  for (const platform of ["win32", "linux"])
    assert.deepEqual(profileCapabilities("frontend", { platform }), [
      "node",
      "pnpm",
      "frontend-dependencies",
      "rustc",
    ]);
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
  assert.equal(frontend.setup.rust, ["win32", "linux"].includes(process.platform));
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

void test("validation consumers share the exact mapping and keep Node wrappers and fixture subsets", () => {
  assert.equal(selectedPrerequisites, validationCapabilities);
  assert.deepEqual(selectedPrerequisites({ id: "repository-lint" }, "darwin"), [
    "node",
    "pnpm",
    "frontend-dependencies",
  ]);
  for (const platform of ["win32", "linux"]) {
    assert(selectedPrerequisites({ id: "repository-lint" }, platform).includes("rustc"));
    assert(!selectedPrerequisites({ id: "oxfmt" }, platform).includes("rustc"));
    assert(!selectedPrerequisites({ id: "node-tests" }, platform).includes("rustc"));
  }
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
    ["node", "npm-vite-plus"],
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

void test("Windows driver-only preparation excludes broad development installation and checks its own pins", async () => {
  const plan = await developmentCapabilityPlan("native-drivers", { platform: "win32" });
  assert.deepEqual(plan.capabilities, ["node", "rustc", "cargo", "tauri-driver", "native-driver"]);
  assert.deepEqual(plan.setup, {
    frontend: false,
    rust: true,
    aqua: false,
    native: true,
    cargo_tools: [],
  });
  for (const platform of ["linux", "darwin"])
    assert.throws(() => profileCapabilities("native-drivers", { platform }), /requires Windows/);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./development-capabilities.mts", import.meta.url)),
      "--profile",
      "native-drivers",
      "--platform",
      "win32",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), plan);
});

function bootstrapFixture(t: TestContext) {
  // Bind guarded re-entry to the same physical fixture across host aliases.
  const directory = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), "portcove capability spaces ")),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = path.join(directory, "checkout with spaces");
  const bin = path.join(directory, "commands");
  const root = fileURLToPath(new URL("..", import.meta.url));
  mkdirSync(bin, { recursive: true });
  for (const name of [
    "scripts/development-capabilities.mts",
    "scripts/runtime-values.mts",
    "scripts/quality-tools.mts",
    "scripts/tool-cache.mts",
    "scripts/bootstrap-quality-tools.sh",
    "scripts/bootstrap-quality-tools.ps1",
    "scripts/windows-webview-driver-policy.psm1",
    "scripts/tool-cache-state.psm1",
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
 if(path.basename(args[0]??"")==="resource-command.mts") {
  if(args[1]==="verify-bootstrap") {if(process.env.PORTCOVE_RESOURCE_RESERVATION!=="fixture-owned")process.exit(95);log(["verify-bootstrap"]);process.exit(0)}
  if(args[1]!=="rust"||args[2]!=="--bootstrap"||args[3]!=="--")process.exit(96);
  const scriptIndex=args.indexOf("-File");const script=scriptIndex<0?args[5]:args[scriptIndex+1];
  if(!path.resolve(script).startsWith(path.resolve(process.env.PCV_TEST_PROJECT)+path.sep))process.exit(97);
  log(["admission",args[1],args[2]]);
  const child=spawnSync(args[4],args.slice(5),{stdio:"inherit",env:{...process.env,PORTCOVE_RESOURCE_RESERVATION:"fixture-owned"}});process.exit(child.status??1);
 }
 if(path.basename(args[0]??"")==="dev-doctor.mts") {log(["doctor",...args.slice(1)]);process.exit(0)}
 if(path.basename(args[0]??"")==="hooks-install.mts") {
  log(["hooks",...args.slice(1)]);
  if(process.env.PCV_TEST_HOOK_FAILURE) {console.error("fixture hook refresh failed");process.exit(71)}
  process.exit(0);
 }
 if(path.basename(args[0]??"")==="development-capabilities.mts"&&process.env.PCV_TEST_PLATFORM)args.push("--platform",process.env.PCV_TEST_PLATFORM);
 const result=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:"inherit",env:process.env});process.exit(result.status??1);
}
log([command,...args]);
const manifest=JSON.parse(readFileSync(".github/quality-tools.json","utf8"));
if(command==="pnpm") {
 if(args[0]==="--version")console.log(JSON.parse(readFileSync("package.json","utf8")).packageManager.split("@")[1]);
 if(args[0]==="install"&&process.env.PCV_TEST_INSTALL_FAILURE) {console.error("fixture dependency install failed");process.exit(72)}
 // A warm install does no lifecycle work: bootstrap must refresh hooks itself.
 process.exit(process.cwd()===process.env.PCV_TEST_PROJECT?0:94);
}
if(command==="rustc") {if(process.env.PCV_TEST_MISSING_RUST)process.exit(1);console.log("rustc "+manifest.rust.channel+" (fixture)");process.exit(0)}
if(command==="cargo") {
 if(args[0]==="nextest"&&process.env.PCV_TEST_MISSING_NEXTEST)process.exit(1);
 if(args[0]==="binstall"&&process.env.PCV_TEST_TOOL_INSTALL_FAILURE) {console.error("fixture pinned tool install failed");process.exit(74)}
 console.log(args[0]==="nextest"?"cargo-nextest "+manifest.tools.find(t=>t.id==="cargo-nextest").version:"fixture component");process.exit(0);
}
process.exit(73);
`,
  );
  const commandNames = ["node", "pnpm", "rustc", "cargo", "cargo-binstall", "rustup", "aqua"];
  for (const command of commandNames) {
    const name = path.join(bin, command + (process.platform === "win32" ? ".cmd" : ""));
    const text =
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${stub}" ${command} %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${stub.replaceAll("'", "'\\''")}' ${command} "$@"\n`;
    writeFileSync(name, text);
    chmodSync(name, 0o755);
  }
  const shellProbe = path.join(directory, "resolve-commands.sh");
  writeFileSync(
    shellProbe,
    'for name; do builtin type -t "$name"; builtin type -P "$name"; done\n',
  );
  const powershellProbe = path.join(directory, "resolve-commands.ps1");
  writeFileSync(
    powershellProbe,
    "$ErrorActionPreference='Stop'; $args | ForEach-Object { $item=Get-Command $_ -ErrorAction Stop; [pscustomobject]@{kind=[string]$item.CommandType;path=$item.Source} } | ConvertTo-Json -Compress",
  );
  return {
    project,
    caller: directory,
    marker,
    run(
      command: string,
      args: string[],
      extra: NodeJS.ProcessEnv = {},
      cwd = project,
      discoveryTimeoutMs = 5000,
    ) {
      const environment = {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        GITHUB_ACTIONS: "false",
        PORTCOVE_CONTAINER_GUEST: "",
        PORTCOVE_RESOURCE_RESERVATION: "",
        PCV_TEST_LOG: log,
        PCV_TEST_PROJECT: project,
        PORTCOVE_SHARED_TOOL_CACHE: path.join(directory, "cache/portcove"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        LOCALAPPDATA: path.join(directory, "cache"),
        ...extra,
      };
      const probe = spawnSync(
        command,
        command === "pwsh"
          ? ["-NoProfile", "-File", powershellProbe, ...commandNames]
          : [shellProbe, ...commandNames],
        {
          cwd: project,
          env: environment,
          encoding: "utf8",
          // Full40763883340/a1 Mac frontend reached this real PowerShell
          // command-discovery probe's5s cutoff. Keep shell probes at5s and
          // the actual bootstrap command at15s; calibrate only pwsh startup.
          timeout: discoveryTimeoutMs,
          maxBuffer: 64 * 1024,
        },
      );
      assert.ifError(probe.error);
      assert.equal(probe.status, 0, probe.stderr);
      const lines = probe.stdout.trim().split(/\r?\n/u);
      const observed: unknown =
        command === "pwsh"
          ? JSON.parse(probe.stdout)
          : commandNames.map((_, index) => ({
              kind: lines[index * 2],
              path: lines[index * 2 + 1],
            }));
      assert.deepEqual(
        observed,
        commandNames.map((name) => ({
          kind: command === "pwsh" ? "Application" : "file",
          path: path.join(bin, name + (process.platform === "win32" ? ".cmd" : "")),
        })),
        "Mocked mutation commands must resolve to the exact disposable executables",
      );
      return spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        timeout: 15000,
        env: environment,
      });
    },
    calls() {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const call: unknown = JSON.parse(line);
          if (!isCommandCall(call)) throw new Error("fixture emitted an invalid command call");
          return call;
        });
    },
  };
}
function isCommandCall(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part: unknown) => typeof part === "string");
}

void test(
  "POSIX frontend setup selects only its supervisor compiler without Core components or Aqua",
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
    assert.match(result.stdout, /Requested pinned Portcove tools are ready \(frontend\)\./);
    const calls = fixture.calls();
    assert.deepEqual(
      calls.map((call) => call[0]),
      [
        "admission",
        "verify-bootstrap",
        "pnpm",
        "pnpm",
        "hooks",
        ...(["win32", "linux"].includes(process.platform) ? ["rustc"] : []),
        "doctor",
      ],
    );
    const packages = calls.filter((call) => call[0] === "pnpm");
    assert.deepEqual(packages[0]?.slice(1), ["--version"]);
    assert.deepEqual(packages[1]?.slice(1), ["install", "--frozen-lockfile"]);
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);

void test(
  "POSIX frontend warm setup refreshes hooks and propagates install or hook failures",
  { skip: process.platform === "win32" },
  (t) => {
    const fixture = bootstrapFixture(t);
    const args = ["scripts/bootstrap-quality-tools.sh", "--profile", "frontend"];
    const first = fixture.run("bash", args);
    assert.equal(first.status, 0, first.stderr);
    let start = fixture.calls().length;
    const warm = fixture.run("bash", args);
    assert.equal(warm.status, 0, warm.stderr);
    assert.match(warm.stdout, /Requested pinned Portcove tools are ready \(frontend\)\./);
    const warmCalls = fixture.calls().slice(start);
    assert.deepEqual(
      warmCalls.filter((call) => ["pnpm", "hooks", "doctor"].includes(call[0] ?? "")),
      [
        ["pnpm", "--version"],
        ["pnpm", "install", "--frozen-lockfile"],
        ["hooks"],
        ["doctor", "--profile", "frontend"],
      ],
    );
    start = fixture.calls().length;
    const failedInstall = fixture.run("bash", args, { PCV_TEST_INSTALL_FAILURE: "1" });
    assert.equal(failedInstall.status, 72, failedInstall.stderr);
    assert.ok(
      !fixture
        .calls()
        .slice(start)
        .some((call) => ["hooks", "rustc", "doctor"].includes(call[0] ?? "")),
    );
    start = fixture.calls().length;
    const failedHooks = fixture.run("bash", args, { PCV_TEST_HOOK_FAILURE: "1" });
    assert.equal(failedHooks.status, 71, failedHooks.stderr);
    assert.deepEqual(fixture.calls().slice(start).at(-1), ["hooks"]);
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);

void test(
  "POSIX Core warm setup selects only nextest; failed Rust acquisition preserves prior state",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = bootstrapFixture(t);
    const result = fixture.run("bash", ["scripts/bootstrap-quality-tools.sh", "--profile", "core"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(
      fixture
        .calls()
        .every((call) =>
          ["admission", "verify-bootstrap", "rustc", "cargo", "doctor"].includes(call[0] ?? ""),
        ),
    );
    assert.ok(fixture.calls().some((call) => call[0] === "cargo" && call[1] === "nextest"));
    const failed = fixture.run(
      "bash",
      ["scripts/bootstrap-quality-tools.sh", "--profile", "core"],
      { PCV_TEST_MISSING_RUST: "1" },
    );
    assert.equal(failed.status, 73, failed.stderr);
    const beforeMissingTool = fixture.calls().length;
    const missingTool = fixture.run(
      "bash",
      ["scripts/bootstrap-quality-tools.sh", "--profile", "core"],
      { PCV_TEST_MISSING_NEXTEST: "1", PCV_TEST_TOOL_INSTALL_FAILURE: "1" },
    );
    assert.equal(missingTool.status, 74, missingTool.stderr);
    assert.match(missingTool.stderr, /fixture pinned tool install failed/);
    const selected = (await developmentCapabilityPlan("core")).setup.cargo_tools;
    assert.equal(selected.length, 1);
    const failedToolCalls = fixture.calls().slice(beforeMissingTool);
    assert.deepEqual(failedToolCalls.at(-1), [
      "cargo",
      "binstall",
      "--no-confirm",
      "--locked",
      `${selected[0]!.crate}@${selected[0]!.version}`,
    ]);
    assert.ok(!failedToolCalls.some((call) => call[0] === "doctor"));
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
    assert.ok(!fixture.calls().some((call) => ["aqua", "pnpm"].includes(call[0] ?? "")));
  },
);

const powershellAvailability = spawnSync("pwsh", ["-NoProfile", "--version"], {
  timeout: 20_000,
  encoding: "utf8",
});
void test(
  "PowerShell frontend setup selects dependencies before unrelated tools",
  {
    timeout: 60_000,
    skip:
      powershellAvailability.error &&
      "code" in powershellAvailability.error &&
      powershellAvailability.error.code === "ENOENT"
        ? "PowerShell executable unavailable"
        : false,
  },
  (t) => {
    // A cold-start timeout or failing executable is a failure, not evidence
    // that the intended PowerShell execution route is unavailable.
    assert.ifError(powershellAvailability.error);
    assert.equal(powershellAvailability.status, 0, powershellAvailability.stderr);
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
      20_000,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      fixture.calls().map((call) => call[0]),
      [
        "admission",
        "verify-bootstrap",
        "pnpm",
        "pnpm",
        "hooks",
        ...(["win32", "linux"].includes(process.platform) ? ["rustc"] : []),
        "doctor",
      ],
    );
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);

void test(
  "PowerShell driver-only setup reaches its scoped installer without pnpm or broad tools",
  { skip: process.platform !== "win32" },
  (t) => {
    const fixture = bootstrapFixture(t);
    const result = fixture.run(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.join(fixture.project, "scripts/bootstrap-quality-tools.ps1"),
        "-Profile",
        "native-drivers",
      ],
      {},
      fixture.caller,
    );
    // The controlled cargo stub creates no driver executable. This deliberate
    // refusal occurs before registry/network acquisition, never native readiness.
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Provide pnpm/);
    assert.match(result.stderr, /tauri-driver installation did not produce/);
    const calls = fixture.calls();
    assert.ok(
      calls.some(
        (call) =>
          call[0] === "cargo" &&
          call.some((arg) => arg === "tauri-driver" || arg === "tauri-driver@2.0.6"),
      ),
      JSON.stringify({ calls, stderr: result.stderr }),
    );
    assert.ok(
      !calls.some(
        (call) => ["pnpm", "hooks", "aqua"].includes(call[0] ?? "") || call.includes("nextest"),
      ),
    );
    assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
  },
);

void test(
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

void test(
  "Darwin frontend's empty tool selection preserves cold and warm setup without tool acquisition",
  { skip: process.platform === "win32" },
  (t) => {
    const fixture = bootstrapFixture(t);
    for (let index = 0; index < 2; index++) {
      const result = fixture.run(
        "bash",
        ["scripts/bootstrap-quality-tools.sh", "--profile", "frontend"],
        { PCV_TEST_PLATFORM: "darwin" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(fixture.marker, "utf8"), "verified prior state\n");
    }
    const calls = fixture.calls();
    assert.ok(!calls.some((call) => ["rustc", "cargo", "rustup", "aqua"].includes(call[0]!)));
    assert.equal(calls.filter((call) => call[0] === "pnpm" && call[1] === "install").length, 2);
    assert.equal(calls.filter((call) => call[0] === "hooks").length, 2);
    assert.equal(calls.filter((call) => call[0] === "doctor").length, 2);
  },
);
