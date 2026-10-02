import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkflowProvenance,
  parseProvenanceArchive,
  validateWorkflowProvenance,
  hostedLocalCheckAuthorityPaths,
  isHostedLocalCheckScriptAuthority,
  hostedLocalCheckEnvironment,
  runHostedLocalCheck,
} from "./workflow-provenance.mjs";

test("preflight and controller share the exact hosted script authority boundary", () => {
  assert.equal(isHostedLocalCheckScriptAuthority("scripts/dev-doctor.mjs"), true);
  assert.equal(isHostedLocalCheckScriptAuthority("apps/desktop/scripts/example.mjs"), true);
  assert.equal(isHostedLocalCheckScriptAuthority("scripts/example.test.mjs"), false);
  assert.equal(isHostedLocalCheckScriptAuthority("scripts/workflow-provenance.mjs"), false);
  assert.equal(isHostedLocalCheckScriptAuthority("apps/desktop/src/example.ts"), false);
  assert.ok(hostedLocalCheckAuthorityPaths.includes("scripts/workflow-provenance.mjs") === false);
});

function hostedFixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-local-check-binding-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const controller = path.join(directory, "controller");
  const git = (cwd, args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (cwd, name, value) => {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), value);
  };
  mkdirSync(source);
  git(source, ["init", "--quiet"]);
  git(source, ["config", "core.autocrlf", "false"]);
  git(source, ["config", "user.name", "Local binding fixture"]);
  git(source, ["config", "user.email", "fixture@example.invalid"]);
  for (const name of hostedLocalCheckAuthorityPaths) write(source, name, "authority\n");
  write(source, "rust-toolchain.toml", 'channel = "1.98.1"\n');
  write(source, ".node-version", process.version.slice(1) + "\n");
  write(source, "package.json", JSON.stringify({ packageManager: "pnpm@12.4.2" }));
  write(
    source,
    ".github/quality-tools.json",
    JSON.stringify({ tools: [{ id: "just", version: "1.58.0" }] }),
  );
  write(source, ".github/workflows/deep-quality.yml", "name: Deep audit\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "trusted authority"]);
  const base = git(source, ["rev-parse", "HEAD"]);
  write(source, "subject.rs", "reviewed source change\n");
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "reviewed subject"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  git(directory, ["clone", "--quiet", source, controller]);
  git(controller, ["config", "core.autocrlf", "false"]);
  git(controller, ["config", "user.name", "Local binding fixture"]);
  git(controller, ["config", "user.email", "fixture@example.invalid"]);
  write(controller, ".github/workflows/deep-quality.yml", "name: Reviewed controller\n");
  git(controller, ["add", "."]);
  git(controller, ["commit", "--quiet", "-m", "reviewed controller"]);
  const controlHead = git(controller, ["rev-parse", "HEAD"]);
  const env = {
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: controlHead,
    GITHUB_WORKFLOW_SHA: controlHead,
    GITHUB_WORKFLOW_REF: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/fixture",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_OS: "Linux",
    RUNNER_ARCH: "X64",
    PORTCOVE_LOCAL_SOURCE_SHA: head,
    PORTCOVE_LOCAL_BASE_SHA: base,
    PORTCOVE_LOCAL_MERGE_BASE_SHA: base,
    PORTCOVE_LOCAL_CONTROLLER_SHA: controlHead,
    PORTCOVE_LOCAL_AUTHORITY_SHA: base,
    CI: "true",
    RUSTUP_TOOLCHAIN: "1.98.1",
    CARGO_INCREMENTAL: "0",
    PATH: process.env.PATH,
    GH_TOKEN: "fixture-secret",
  };
  const logs = [];
  const command = (name, args, cwd) => {
    if (name === "git") return git(cwd, args);
    return {
      just: "just 1.58.0",
      rustc: "rustc 1.98.1 (fixture)",
      cargo: "cargo 1.98.1 (fixture)",
      pnpm: "12.4.2",
    }[name];
  };
  return {
    source,
    controller,
    git,
    write,
    env,
    head,
    base,
    logs,
    options: {
      controllerRoot: controller,
      environment: env,
      command,
      log: (line) => logs.push(line),
    },
  };
}

test("hosted local execution preserves defaults and removes provisioning credentials", () => {
  const child = hostedLocalCheckEnvironment(
    {
      CI: "true",
      PATH: "/pinned/tools",
      RUSTUP_TOOLCHAIN: "1.98.1",
      GH_TOKEN: "private",
      ACTIONS_RUNTIME_TOKEN: "private",
    },
    "1.98.1",
  );
  assert.equal(child.PATH, "/pinned/tools");
  assert.equal(child.CARGO_BUILD_JOBS, "4");
  for (const name of [
    "CI",
    "RUSTUP_TOOLCHAIN",
    "CARGO_INCREMENTAL",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
  ])
    assert.ok(!(name in child));
  for (const name of [
    "RUSTFLAGS",
    "RUSTDOCFLAGS",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_ENCODED_RUSTDOCFLAGS",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_TARGET",
    "CARGO_TARGET_DIR",
    "CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS",
    "CARGO_PROFILE_TEST_DEBUG",
    "CARGO_PROFILE_DEV_OPT_LEVEL",
    "NODE_OPTIONS",
    "PORTCOVE_TEST_FIXTURES",
    "PORTCOVE_HEAVY_RUST_WAIT_MS",
    "PORTCOVE_MIN_FREE_GIB",
    "PORTCOVE_TEMP_DIR",
    "PORTCOVE_OUTPUT_DIR",
    "PORTCOVE_PNPM_STORE_DIR",
    "PORTCOVE_SHARED_TOOL_CACHE",
    "PORTCOVE_HOST_TOOL_FIXTURE",
  ])
    assert.throws(
      () => hostedLocalCheckEnvironment({ [name]: "unsupported" }, "1.98.1"),
      /Unsupported.*override/,
    );
  assert.throws(
    () => hostedLocalCheckEnvironment({ CARGO_BUILD_JOBS: "8" }, "1.98.1"),
    /must be 4/,
  );
  assert.throws(
    () => hostedLocalCheckEnvironment({ RUSTUP_TOOLCHAIN: "nightly" }, "1.98.1"),
    /repository pin/,
  );
  assert.throws(
    () => hostedLocalCheckEnvironment({ pnpm_config_store_dir: "/unowned/store" }, "1.98.1"),
    /owned source checkout/,
  );
});

function cargoFixture(t, twoManifests = false) {
  const f = hostedFixture(t);
  f.git(f.source, ["reset", "--hard", f.base]);
  const packageName = twoManifests ? "minisign-verify" : "minisign";
  const oldVersion = twoManifests ? "0.2.5" : "0.9.1";
  const newVersion = twoManifests ? "0.3.0" : "0.10.0";
  const manifests = [
    {
      path: "crates/portcove-release-tools/Cargo.toml",
      section: twoManifests ? "dependencies" : "dev-dependencies",
    },
  ];
  if (twoManifests)
    manifests.push({ path: "apps/desktop/src-tauri/Cargo.toml", section: "dependencies" });
  const checksum = "a".repeat(64);
  const nextChecksum = "b".repeat(64);
  const lock = `# Generated lock\nversion = 4\n\n[[package]]\nname = "${packageName}"\nversion = "${oldVersion}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n${twoManifests ? "" : 'dependencies = [\n "ct-codecs",\n]\n'}\n`;
  f.write(f.source, "Cargo.lock", lock);
  for (const entry of manifests)
    f.write(
      f.source,
      entry.path,
      `[package]\nname = "fixture"\nversion = "0.1.0"\n\n[${entry.section}]\n${packageName} = "${oldVersion}"\n`,
    );
  f.git(f.source, ["add", "."]);
  f.git(f.source, ["commit", "--quiet", "-m", "trusted Cargo authority"]);
  const authority = f.git(f.source, ["rev-parse", "HEAD"]);
  const nextLock = lock
    .replace(`version = "${oldVersion}"`, `version = "${newVersion}"`)
    .replace(checksum, nextChecksum);
  f.write(f.source, "Cargo.lock", nextLock);
  for (const entry of manifests)
    f.write(
      f.source,
      entry.path,
      readFileSync(path.join(f.source, entry.path), "utf8").replace(
        `"${oldVersion}"`,
        `"${newVersion}"`,
      ),
    );
  const spec = {
    package: packageName,
    from_version: oldVersion,
    to_version: newVersion,
    from_checksum: checksum,
    to_checksum: nextChecksum,
    lock_sha256: createHash("sha256").update(nextLock).digest("hex"),
    manifests,
  };
  const commit = () => {
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "reviewed dependency"]);
    f.env.PORTCOVE_LOCAL_SOURCE_SHA = f.git(f.source, ["rev-parse", "HEAD"]);
    f.env.PORTCOVE_LOCAL_BASE_SHA = authority;
    f.env.PORTCOVE_LOCAL_MERGE_BASE_SHA = authority;
    f.env.PORTCOVE_LOCAL_AUTHORITY_SHA = authority;
    f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = JSON.stringify(spec);
  };
  commit();
  return { ...f, spec, commit };
}

test("opt-in Cargo binding admits only the reviewed one/two-manifest updates", async (t) => {
  for (const count of [false, true]) {
    const f = cargoFixture(t, count);
    assert.equal(await runHostedLocalCheck("prepare", f.options), 0);
    const calls = [];
    assert.equal(
      await runHostedLocalCheck("run", {
        ...f.options,
        spawn: (name, args, options) => {
          calls.push({ name, args, options });
          return { status: 0 };
        },
      }),
      0,
    );
    assert.deepEqual(
      calls.map(({ name, args }) => [name, ...args]),
      [
        ["just", "local-check", "--plan"],
        ["just", "local-check", "--fresh"],
      ],
    );
    assert.ok(
      calls.every(
        ({ options }) => options.env.GH_TOKEN === undefined && options.env.CARGO_BUILD_JOBS === "4",
      ),
    );
    assert.ok(
      f.logs.some(
        (line) =>
          line.includes('"profile":"cargo-dependency"') && line.includes(f.spec.lock_sha256),
      ),
    );
    delete f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING;
    await assert.rejects(runHostedLocalCheck("prepare", f.options), /changes trusted.*authority/);
  }
});

test("Cargo binding rejects every other tree, mode and dependency-byte change", async (t) => {
  const mutations = [
    (f) => f.write(f.source, "subject.rs", "extra source\n"),
    (f) => f.write(f.source, "scripts/local-validation.mjs", "altered selector\n"),
    (f) => f.write(f.source, "Cargo.toml", "altered root\n"),
    (f) => f.write(f.source, ".cargo/config.toml", "altered flags\n"),
    (f) =>
      f.write(
        f.source,
        "Cargo.lock",
        readFileSync(path.join(f.source, "Cargo.lock"), "utf8") +
          '\n[[package]]\nname = "extra"\nversion = "1.0.0"\n',
      ),
    (f) =>
      f.write(
        f.source,
        "Cargo.lock",
        readFileSync(path.join(f.source, "Cargo.lock"), "utf8") + " \n",
      ),
    (f) =>
      f.write(
        f.source,
        "Cargo.lock",
        readFileSync(path.join(f.source, "Cargo.lock"), "utf8").replace(
          "registry+https://github.com/rust-lang/crates.io-index",
          "git+https://example.invalid",
        ),
      ),
    (f) =>
      f.write(
        f.source,
        f.spec.manifests[0].path,
        readFileSync(path.join(f.source, f.spec.manifests[0].path), "utf8").replace(
          'minisign = "0.10.0"',
          'minisign = { version = "0.10.0", default-features = false }',
        ),
      ),
    (f) =>
      f.write(
        f.source,
        f.spec.manifests[0].path,
        readFileSync(path.join(f.source, f.spec.manifests[0].path), "utf8") +
          '[dev-dependencies]\nminisign = "0.10.0"\n',
      ),
    (f) => f.git(f.source, ["rm", f.spec.manifests[0].path]),
    (f) => {
      chmodSync(path.join(f.source, "Cargo.lock"), 0o755);
      f.git(f.source, ["update-index", "--chmod=+x", "Cargo.lock"]);
    },
  ];
  const f = cargoFixture(t);
  const originalHead = f.env.PORTCOVE_LOCAL_SOURCE_SHA;
  for (const mutate of mutations) {
    f.git(f.source, ["reset", "--hard", originalHead]);
    mutate(f);
    f.commit();
    await assert.rejects(
      runHostedLocalCheck("prepare", f.options),
      /Invalid reviewed Cargo dependency binding/,
    );
  }
});

test("Cargo binding rejects ambiguous or unreviewed declarations and digests", async (t) => {
  const f = cargoFixture(t);
  const originalSpec = structuredClone(f.spec);
  for (const update of [
    (s) => {
      s.lock_sha256 = "c".repeat(64);
    },
    (s) => {
      s.to_checksum = "c".repeat(64);
    },
    (s) => {
      s.to_version = '0.10.0"\npath = "evil';
    },
    (s) => {
      s.manifests.push(s.manifests[0]);
    },
    (s) => {
      s.manifests[0].path = "Cargo.toml";
    },
    (s) => {
      s.manifests[0].section = "build-dependencies";
    },
    (s) => {
      s.extra = "ignored";
    },
    (s) => {
      s.package = [s.package];
    },
    (s) => {
      s.from_version = [s.from_version];
    },
    (s) => {
      s.to_checksum = [s.to_checksum];
    },
  ]) {
    f.spec = structuredClone(originalSpec);
    update(f.spec);
    f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = JSON.stringify(f.spec);
    await assert.rejects(runHostedLocalCheck("prepare", f.options), /binding|digest/);
  }
  f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = JSON.stringify(originalSpec);
  f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING = f.env.PORTCOVE_LOCAL_DEPENDENCY_BINDING.replace(
    "{",
    '{"package":"hidden",',
  );
  await assert.rejects(runHostedLocalCheck("prepare", f.options), /binding/);
});

test("Cargo binding is rechecked after provisioning and execution", async (t) => {
  const f = cargoFixture(t);
  assert.equal(await runHostedLocalCheck("prepare", f.options), 0);
  f.write(f.source, "Cargo.lock", "tampered provisioning\n");
  await assert.rejects(runHostedLocalCheck("run", f.options), /dirty/);
  f.git(f.source, ["checkout", "--", "Cargo.lock"]);
  await assert.rejects(
    runHostedLocalCheck("run", {
      ...f.options,
      spawn: () => {
        f.write(f.source, "Cargo.lock", "tampered execution\n");
        return { status: 0 };
      },
    }),
    /dirty/,
  );
});

test("planning cannot change the reviewed lock before fresh execution", async (t) => {
  const f = cargoFixture(t);
  const calls = [];
  await assert.rejects(
    runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => {
        calls.push(args);
        f.write(f.source, "Cargo.lock", "metadata changed the graph\n");
        return { status: 0 };
      },
    }),
    /dirty/,
  );
  assert.deepEqual(calls, [["local-check", "--plan"]]);
  assert.ok(!f.logs.some((line) => line.startsWith("Hosted local-check completed:")));
});

test("multiline TOML descriptions cannot masquerade as dependency tables", async (t) => {
  for (const delimiter of ['"""', "'''"]) {
    const f = cargoFixture(t);
    f.git(f.source, ["reset", "--hard", f.env.PORTCOVE_LOCAL_AUTHORITY_SHA]);
    const manifest = f.spec.manifests[0].path;
    const text = `[package]\nname = "fixture"\nversion = "0.1.0"\ndescription = ${delimiter}\n[dev-dependencies]\nminisign = "0.9.1"\n${delimiter}\n\n[dev-dependencies] # actual table\nminisign = "0.9.1"\n`;
    f.write(f.source, manifest, text);
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "valid multiline authority"]);
    const authority = f.git(f.source, ["rev-parse", "HEAD"]);
    f.write(f.source, manifest, text.replace('minisign = "0.9.1"', 'minisign = "0.10.0"'));
    const lock = readFileSync(path.join(f.source, "Cargo.lock"), "utf8")
      .replace('version = "0.9.1"', 'version = "0.10.0"')
      .replace("a".repeat(64), "b".repeat(64));
    f.write(f.source, "Cargo.lock", lock);
    f.spec.lock_sha256 = createHash("sha256").update(lock).digest("hex");
    f.commit();
    f.env.PORTCOVE_LOCAL_AUTHORITY_SHA = authority;
    f.env.PORTCOVE_LOCAL_BASE_SHA = authority;
    f.env.PORTCOVE_LOCAL_MERGE_BASE_SHA = authority;
    await assert.rejects(
      runHostedLocalCheck("prepare", f.options),
      /Invalid reviewed Cargo dependency binding/,
    );
  }
});

test("hosted execution binds actual Git source, default base, controller and final child", async (t) => {
  const f = hostedFixture(t);
  const calls = [];
  const status = await runHostedLocalCheck("run", {
    ...f.options,
    spawn: (name, args, options) => {
      calls.push({ name, args, options });
      assert.equal(f.git(f.source, ["rev-parse", "origin/main"]), f.base);
      assert.equal(options.env.CI, undefined);
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.CARGO_BUILD_JOBS, "4");
      assert.equal(options.env.CARGO_INCREMENTAL, undefined);
      assert.equal(options.env.RUNNER_TEMP, undefined);
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(
    calls.map(({ name, args }) => [name, ...args]),
    [
      ["just", "local-check", "--plan"],
      ["just", "local-check", "--fresh"],
    ],
  );
  assert.ok(
    calls.every((call) => call.options.cwd === f.source && call.options.stdio === "inherit"),
  );
  assert.ok(f.logs.some((line) => line.startsWith("Hosted local-check completed:")));
});

test("hosted binding rejects frontend validation helper and test-policy changes", async (t) => {
  for (const name of [
    "apps/desktop/scripts/check-copy.mjs",
    "apps/desktop/vitest.config.ts",
    "apps/desktop/stylelint.config.mjs",
    "apps/desktop/tsconfig.orchestration.json",
    "apps/desktop/i18next.config.ts",
    "apps/desktop/i18next.invalid.config.ts",
  ]) {
    const f = hostedFixture(t);
    f.write(f.source, name, "process.exit(0);\n");
    f.git(f.source, ["add", "."]);
    f.git(f.source, ["commit", "--quiet", "-m", "altered frontend validation"]);
    f.env.PORTCOVE_LOCAL_SOURCE_SHA = f.git(f.source, ["rev-parse", "HEAD"]);
    await assert.rejects(runHostedLocalCheck("prepare", f.options), /changes trusted.*authority/);
  }
});

test("hosted binding rejects source, workflow, base, dirt and authority mismatches", async (t) => {
  const f = hostedFixture(t);
  for (const [name, value, message] of [
    ["PORTCOVE_LOCAL_SOURCE_SHA", "refs/heads/main", /Exact source/],
    ["GITHUB_WORKFLOW_SHA", "f".repeat(40), /controller context/],
    ["PORTCOVE_LOCAL_MERGE_BASE_SHA", f.head, /merge-base differs/],
    ["PORTCOVE_LOCAL_SOURCE_SHA", f.base, /checkout is dirty/],
  ])
    await assert.rejects(
      runHostedLocalCheck("prepare", { ...f.options, environment: { ...f.env, [name]: value } }),
      message,
    );
  f.write(f.source, "untracked.rs", "dirty\n");
  await assert.rejects(runHostedLocalCheck("prepare", f.options), /checkout is dirty/);
  rmSync(path.join(f.source, "untracked.rs"));
  f.write(f.source, "scripts/local-validation.mjs", "altered selector\n");
  f.git(f.source, ["add", "."]);
  f.git(f.source, ["commit", "--quiet", "-m", "altered authority"]);
  f.env.PORTCOVE_LOCAL_SOURCE_SHA = f.git(f.source, ["rev-parse", "HEAD"]);
  await assert.rejects(runHostedLocalCheck("prepare", f.options), /changes trusted.*authority/);
});

test("hosted completion never upgrades failed, interrupted or altered execution", async (t) => {
  const f = hostedFixture(t);
  assert.equal(
    await runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => ({ status: args.includes("--fresh") ? 7 : 0 }),
    }),
    7,
  );
  assert.ok(!f.logs.some((line) => line.startsWith("Hosted local-check completed:")));
  assert.equal(
    await runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => ({ status: args.includes("--fresh") ? null : 0, signal: "SIGTERM" }),
    }),
    1,
  );
  await assert.rejects(
    runHostedLocalCheck("run", {
      ...f.options,
      spawn: (_name, args) => {
        if (args.includes("--fresh")) f.write(f.source, "subject.rs", "altered during execution\n");
        return { status: 0 };
      },
    }),
    /checkout is dirty/,
  );
  assert.ok(!f.logs.some((line) => line.startsWith("Hosted local-check completed:")));
});

test("manual local-check transport preserves the audit and has no mutable execution inputs", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
    "utf8",
  );
  const local = workflow.split("\n  local_check:\n")[1];
  assert.ok(local);
  assert.match(workflow, /options: \[audit, local-check\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /just audit --fresh/);
  assert.match(local, /runs-on: ubuntu-24\.04/);
  assert.equal((local.match(/persist-credentials: false/gu) ?? []).length, 2);
  assert.match(
    local,
    /hosted-local-check controller[\s\S]*path: source[\s\S]*hosted-local-check prepare[\s\S]*bootstrap-quality-tools\.sh[\s\S]*hosted-local-check run/,
  );
  assert.match(local, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(
    local,
    /actions\/cache|rust-cache|upload-artifact|secrets\.|contents: write|CARGO_PROFILE_/,
  );
  assert.doesNotMatch(local, /run:.*\$\{\{ inputs\./);
});

const sha = (letter) => letter.repeat(40);
const environment = {
  GITHUB_WORKFLOW_SHA: sha("a"),
  GITHUB_SHA: sha("b"),
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "3",
  GITHUB_REPOSITORY: "example/repo",
  GITHUB_WORKFLOW_REF: "example/repo/.github/workflows/ci.yml@refs/pull/7/merge",
  GITHUB_EVENT_NAME: "pull_request",
  PORTCOVE_HEAD_SHA: sha("c"),
  PORTCOVE_PLAN_DIGEST: "d".repeat(64),
  PORTCOVE_PLAN_MODE: "qualification",
  PORTCOVE_CALLER: "pull-request",
  GITHUB_JOB: "provenance",
};
const build = (overrides = {}) =>
  buildWorkflowProvenance({
    workflow: "ci.yml",
    mode: "ci",
    desiredRunner: "ubuntu-latest",
    workflowContents: "name: CI\n",
    desired: {
      node: "24.21.0",
      package_manager: "12.4.1",
      rust: "1.98.1",
      build_configuration: { ci: true },
    },
    observed: {
      node: "24.21.0",
      package_manager: "12.4.1",
      rust: "1.98.1",
      cargo: "1.98.1",
      runner: { os: "Linux", architecture: "X64" },
      build_configuration: { ci: true },
    },
    environment,
    checkoutSha: sha("b"),
    ...overrides,
  });
const validationContext = {
  runId: 42,
  attempt: 3,
  headSha: sha("c"),
  repository: "example/repo",
  workflow: "ci.yml",
  event: "pull_request",
};

function storedZip(name, contents) {
  const data = Buffer.from(contents);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
}

test("binds official workflow source context, checked-out code, and exact configurations", () => {
  const record = build();
  assert.equal(record.workflow.source_sha, sha("a"));
  assert.equal(record.workflow.caller_path, ".github/workflows/ci.yml");
  assert.equal(record.workflow.called_path, ".github/workflows/ci.yml");
  assert.equal(record.workflow.called_source_sha, sha("b"));
  assert.equal(record.checkout.sha, sha("b"));
  assert.equal(record.checkout.head_sha, sha("c"));
  assert.equal(record.format_version, 4);
  assert.equal(record.validation.plan_digest, "d".repeat(64));
  assert.equal(record.validation.caller, "pull-request");
  assert.equal(record.job_toolchains.length, 1);
  assert.equal(
    record.workflow.content_sha256,
    createHash("sha256").update("name: CI\n").digest("hex"),
  );
  assert.ok(Object.values(record.matches).every(Boolean));
  assert.equal(validateWorkflowProvenance(record, validationContext), record);
  assert.throws(
    () => build({ observed: { ...build().observed, node: "25.0.0" } }),
    /differs from desired/u,
  );
});

test("records unused package and Rust toolchains as not applicable", () => {
  const full = build();
  const record = build({
    observed: {
      ...full.observed,
      package_manager: null,
      rust: null,
      cargo: null,
    },
  });
  assert.deepEqual(record.matches, {
    node: true,
    package_manager: null,
    rust: null,
    cargo: null,
    build_configuration: true,
  });
  assert.equal(record.job_toolchains[0].node, "24.21.0");
  assert.equal(record.job_toolchains[0].rust, null);
  assert.equal(validateWorkflowProvenance(record, validationContext), record);
});

test("binds a reusable workflow to both its top-level caller and called file", () => {
  const reusableEnvironment = {
    ...environment,
    GITHUB_WORKFLOW_REF: "example/repo/.github/workflows/qualification.yml@refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    PORTCOVE_CALLER: "schedule",
  };
  const record = build({ callerWorkflow: "qualification.yml", environment: reusableEnvironment });
  assert.equal(record.workflow.caller_path, ".github/workflows/qualification.yml");
  assert.equal(record.workflow.called_path, ".github/workflows/ci.yml");
  assert.equal(
    validateWorkflowProvenance(record, {
      ...validationContext,
      workflow: "qualification.yml",
      calledWorkflow: "ci.yml",
      event: "schedule",
    }),
    record,
  );
});

test("rejects substituted workflow refs, checkout SHAs, and artifact identities", () => {
  assert.throws(
    () =>
      build({
        environment: { ...environment, GITHUB_WORKFLOW_REF: "example/repo/other.yml@main" },
      }),
    /WORKFLOW_REF/u,
  );
  assert.throws(() => build({ checkoutSha: sha("c") }), /does not match GITHUB_SHA/u);
  assert.throws(
    () => validateWorkflowProvenance(build(), { ...validationContext, attempt: 2 }),
    /identity/u,
  );
});

test("rejects incomplete match evidence and substituted cohort identities", () => {
  const withoutMatches = build();
  delete withoutMatches.matches;
  assert.throws(() => validateWorkflowProvenance(withoutMatches, validationContext), /identity/u);
  const substitutedCohort = build();
  substitutedCohort.equivalent_cohort = "f".repeat(64);
  assert.throws(
    () => validateWorkflowProvenance(substitutedCohort, validationContext),
    /identity/u,
  );
  assert.throws(
    () =>
      validateWorkflowProvenance(build(), {
        ...validationContext,
        workflow: "release.yml",
      }),
    /identity/u,
  );
});

test("rejects missing plan, caller, and provenance-job toolchain identity", () => {
  assert.throws(() => build({ validationPlanDigest: "missing" }), /plan digest/u);
  assert.throws(() => build({ caller: "Bad caller" }), /caller/u);
  const missingJobs = build();
  missingJobs.job_toolchains = [];
  assert.throws(() => validateWorkflowProvenance(missingJobs, validationContext), /identity/u);

  const missingDesiredRust = build({
    desired: {
      node: "24.21.0",
      package_manager: "12.4.1",
      build_configuration: { ci: true },
    },
    observed: {
      ...build().observed,
      rust: null,
      cargo: null,
    },
  });
  assert.throws(
    () => validateWorkflowProvenance(missingDesiredRust, validationContext),
    /identity/u,
  );
});

test("extracts exactly one bounded provenance JSON file from an artifact ZIP", () => {
  const record = build();
  assert.deepEqual(
    parseProvenanceArchive(storedZip("workflow-provenance.json", JSON.stringify(record))),
    record,
  );
  assert.throws(() => parseProvenanceArchive(storedZip("other.json", "{}")), /one JSON/u);
});
