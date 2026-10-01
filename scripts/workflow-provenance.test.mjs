import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkflowProvenance,
  parseProvenanceArchive,
  validateWorkflowProvenance,
  hostedLocalCheckAuthorityPaths,
  hostedLocalCheckEnvironment,
  runHostedLocalCheck,
} from "./workflow-provenance.mjs";

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
