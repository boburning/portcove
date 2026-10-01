#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const exactSha = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");
const exactPositiveInteger = (value) => /^[1-9]\d*$/u.test(value ?? "");

// The fixed local recipe's selection, execution, containment and tool authorities.
// This transport rejects authority changes; it cannot qualify a changed selector.
export const hostedLocalCheckAuthorityPaths = Object.freeze([
  "AGENTS.md",
  ".gitattributes",
  ".gitmodules",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  "taplo.toml",
  "deny.toml",
  "docs/QUALITY.md",
  "justfile",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".node-version",
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/vitest.config.ts",
  "apps/desktop/vitest.browser.config.ts",
  "apps/desktop/vite.config.ts",
  "apps/desktop/tsconfig.json",
  "apps/desktop/tsconfig.orchestration.json",
  "apps/desktop/tsconfig.node.json",
  "apps/desktop/stylelint.config.mjs",
  "apps/desktop/.fallowrc.json",
  "apps/desktop/i18next.config.ts",
  "apps/desktop/i18next.invalid.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".aqua-version",
  "aqua.yaml",
  "aqua-checksums.json",
  ".config/tool-bootstrap.json",
  ".config/nextest.toml",
  ".config/rust-test-impact.json",
  ".cargo/config",
  ".cargo/config.toml",
  ".github/quality-tools.json",
  ".github/qualification-coverage.json",
  ".github/workflows/ci.yml",
  "scripts/local-validation.mjs",
  "scripts/validation-plan.mjs",
  "scripts/audit.mjs",
  "scripts/dev-storage.mjs",
  "scripts/tool-cache.mjs",
  "scripts/select-ci-plan.mjs",
  "scripts/rust-test-impact.mjs",
  "scripts/qualification-coverage.mjs",
  "scripts/oxfmt-ownership.mjs",
  "scripts/run-rust-tests.mjs",
  "scripts/heavy-rust-test-lock.mjs",
  "scripts/rust-support-cache.mjs",
  "scripts/rust-test-tree-supervisor.mjs",
  "scripts/quality-tools.mjs",
  "scripts/test-duration-reporter.mjs",
  "scripts/bootstrap-quality-tools.sh",
  "scripts/install-linux-desktop-prerequisites.sh",
  "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
  "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
]);

export function hostedLocalCheckEnvironment(
  environment,
  rustPin,
  sourceRoot = path.resolve(root, "../source"),
) {
  const child = { ...environment };
  for (const name of Object.keys(child)) {
    if (
      /^(?:RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|RUSTC|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|NODE_OPTIONS|PORTCOVE_TEST_FIXTURES)$/u.test(
        name,
      ) ||
      /^CARGO_(?:PROFILE_|TARGET_.*_(?:RUSTFLAGS|RUSTDOCFLAGS|LINKER|RUNNER)$|BUILD_(?:TARGET|RUSTC|RUSTDOC|RUSTFLAGS))/u.test(
        name,
      ) ||
      name === "CARGO_TARGET_DIR" ||
      (name.startsWith("PORTCOVE_") &&
        !name.startsWith("PORTCOVE_LOCAL_") &&
        !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(name))
    )
      throw new Error(`Unsupported local-check environment override: ${name}`);
    if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/iu.test(name)) delete child[name];
  }
  if (child.CI !== undefined && child.CI !== "true")
    throw new Error("Unexpected provisioning CI environment");
  if (child.CARGO_BUILD_JOBS !== undefined && child.CARGO_BUILD_JOBS !== "4")
    throw new Error("CARGO_BUILD_JOBS must be 4");
  if (child.CARGO_INCREMENTAL !== undefined && child.CARGO_INCREMENTAL !== "0")
    throw new Error("Unexpected provisioning CARGO_INCREMENTAL override");
  if (
    child.pnpm_config_store_dir !== undefined &&
    child.pnpm_config_store_dir !== path.join(sourceRoot, "work", "pnpm-store")
  )
    throw new Error("Package-manager store differs from the owned source checkout");
  if (
    child.RUSTUP_TOOLCHAIN !== undefined &&
    ![rustPin, `${rustPin}-x86_64-unknown-linux-gnu`].includes(child.RUSTUP_TOOLCHAIN)
  )
    throw new Error("RUSTUP_TOOLCHAIN differs from the repository pin");
  delete child.CI;
  delete child.RUSTUP_TOOLCHAIN;
  delete child.CARGO_INCREMENTAL;
  delete child.RUNNER_TEMP;
  child.CARGO_BUILD_JOBS = "4";
  return child;
}

function hostedLocalCheckIdentities(environment) {
  const fields = {
    source: environment.PORTCOVE_LOCAL_SOURCE_SHA,
    base: environment.PORTCOVE_LOCAL_BASE_SHA,
    mergeBase: environment.PORTCOVE_LOCAL_MERGE_BASE_SHA,
    controller: environment.PORTCOVE_LOCAL_CONTROLLER_SHA,
    authority: environment.PORTCOVE_LOCAL_AUTHORITY_SHA,
  };
  for (const [name, value] of Object.entries(fields))
    if (!exactSha(value)) throw new Error(`Exact ${name} SHA is required`);
  if (
    environment.GITHUB_REPOSITORY !== "boburning/portcove" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_SHA !== fields.controller ||
    environment.GITHUB_WORKFLOW_SHA !== fields.controller ||
    !environment.GITHUB_WORKFLOW_REF?.startsWith(
      "boburning/portcove/.github/workflows/deep-quality.yml@",
    ) ||
    !exactPositiveInteger(environment.GITHUB_RUN_ID) ||
    !exactPositiveInteger(environment.GITHUB_RUN_ATTEMPT) ||
    environment.RUNNER_OS !== "Linux" ||
    environment.RUNNER_ARCH !== "X64"
  )
    throw new Error("Hosted controller context does not match the reviewed execution");
  return fields;
}

const cargoDependencyManifests = new Set([
  "crates/portcove-release-tools/Cargo.toml",
  "apps/desktop/src-tauri/Cargo.toml",
]);

// This is a token-only transformation of trusted bytes, not a TOML normalizer.
// The reviewed authority remains independent of the dependency candidate.
function cargoDependencyBinding(raw, git, sourceRoot, identities) {
  if (!raw) return null;
  const fail = () => {
    throw new Error("Invalid reviewed Cargo dependency binding");
  };
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    fail();
  }
  if (JSON.stringify(spec) !== raw || !spec || Array.isArray(spec)) fail();
  const keys = [
    "package",
    "from_version",
    "to_version",
    "from_checksum",
    "to_checksum",
    "lock_sha256",
    "manifests",
  ];
  if (Object.keys(spec).sort().join() !== keys.sort().join()) fail();
  if (typeof spec.package !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(spec.package)) fail();
  for (const key of ["from_version", "to_version"])
    if (
      typeof spec[key] !== "string" ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(spec[key])
    )
      fail();
  for (const key of ["from_checksum", "to_checksum", "lock_sha256"])
    if (typeof spec[key] !== "string" || !/^[a-f0-9]{64}$/u.test(spec[key])) fail();
  if (
    spec.from_version === spec.to_version ||
    !Array.isArray(spec.manifests) ||
    spec.manifests.length < 1 ||
    spec.manifests.length > 2
  )
    fail();
  const paths = new Set(["Cargo.lock"]);
  for (const entry of spec.manifests) {
    if (
      !entry ||
      Object.keys(entry).sort().join() !== "path,section" ||
      !cargoDependencyManifests.has(entry.path) ||
      paths.has(entry.path) ||
      !["dependencies", "dev-dependencies"].includes(entry.section)
    )
      fail();
    paths.add(entry.path);
  }
  const changed = git(sourceRoot, [
    "diff",
    "--name-only",
    "--no-renames",
    identities.authority,
    identities.source,
  ])
    .split("\n")
    .filter(Boolean);
  if (changed.length !== paths.size || changed.some((name) => !paths.has(name))) fail();
  const bytes = (revision, name) => {
    const tree = git(sourceRoot, ["ls-tree", revision, "--", name]);
    if (!/^100644 blob [a-f0-9]{40}\t/u.test(tree)) fail();
    const blob = execFileSync("git", ["show", `${revision}:${name}`], {
      cwd: sourceRoot,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = blob.toString("utf8");
    if (!Buffer.from(text).equals(blob)) fail();
    return text;
  };
  const before = bytes(identities.authority, "Cargo.lock");
  const after = bytes(identities.source, "Cargo.lock");
  const blocks = before.split(/(?=^\[\[package\]\]$)/mu);
  const matching = blocks.filter(
    (block) =>
      block.startsWith("[[package]]\n") &&
      block.split("\n").includes(`name = "${spec.package}"`) &&
      block.split("\n").includes(`version = "${spec.from_version}"`),
  );
  if (matching.length !== 1) fail();
  const block = matching[0];
  const prefix = `[[package]]\nname = "${spec.package}"\nversion = "${spec.from_version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${spec.from_checksum}"`;
  if (!block.startsWith(prefix) || !/^(?:\n|$)/u.test(block.slice(prefix.length))) fail();
  // Only canonical Cargo-generated optional dependency arrays may follow.
  if (
    !/^(?:\n(?:dependencies = \[\n(?: "[^"\r\n]+",\n)*\]\n?)?)?\n*$/u.test(
      block.slice(prefix.length),
    )
  )
    fail();
  const replacement = block
    .replace(`version = "${spec.from_version}"`, `version = "${spec.to_version}"`)
    .replace(`checksum = "${spec.from_checksum}"`, `checksum = "${spec.to_checksum}"`);
  if (blocks.map((value) => (value === block ? replacement : value)).join("") !== after) fail();
  // Reject an existing duplicate new identity; no other package can be altered.
  if (
    after
      .split(/(?=^\[\[package\]\]$)/mu)
      .filter(
        (value) =>
          value.startsWith("[[package]]\n") &&
          value.split("\n").includes(`name = "${spec.package}"`) &&
          value.split("\n").includes(`version = "${spec.to_version}"`),
      ).length !== 1
  )
    fail();
  const manifestBindings = [];
  for (const entry of spec.manifests) {
    const old = bytes(identities.authority, entry.path);
    const next = bytes(identities.source, entry.path);
    const lines = old.split("\n");
    let section = "";
    let found = -1;
    let declarations = 0;
    let tables = 0;
    for (let index = 0; index < lines.length; index++) {
      if (/^\[/u.test(lines[index])) section = lines[index];
      if (lines[index] === `[${entry.section}]`) tables++;
      if (section === `[${entry.section}]` && lines[index].startsWith(`${spec.package} = `)) {
        declarations++;
        if (lines[index] === `${spec.package} = "${spec.from_version}"`) found = index;
      }
    }
    if (tables !== 1 || declarations !== 1 || found < 0) fail();
    lines[found] = `${spec.package} = "${spec.to_version}"`;
    if (lines.join("\n") !== next) fail();
    manifestBindings.push({
      ...entry,
      blob: git(sourceRoot, ["rev-parse", `${identities.source}:${entry.path}`]),
    });
  }
  return { profile: "cargo-dependency", ...spec, manifests: manifestBindings };
}

export async function runHostedLocalCheck(phase, options = {}) {
  if (!["controller", "prepare", "run"].includes(phase))
    throw new Error("hosted-local-check requires controller, prepare or run");
  const environment = options.environment ?? process.env;
  const identities = hostedLocalCheckIdentities(environment);
  const controllerRoot = options.controllerRoot ?? root;
  const sourceRoot = path.resolve(controllerRoot, "../source");
  const invoke = options.command ?? command;
  const log = options.log ?? console.log;
  const git = (cwd, args) => invoke("git", args, cwd);
  const clean = (cwd, expected) => {
    if (
      path.resolve(git(cwd, ["rev-parse", "--show-toplevel"])) !== path.resolve(cwd) ||
      git(cwd, ["rev-parse", "HEAD"]) !== expected ||
      git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]) !== ""
    )
      throw new Error("Local-check checkout is dirty or has a different identity");
  };
  clean(controllerRoot, identities.controller);
  const workflow = await readFile(path.join(controllerRoot, ".github/workflows/deep-quality.yml"));
  if (
    git(controllerRoot, ["hash-object", ".github/workflows/deep-quality.yml"]) !==
    git(controllerRoot, [
      "rev-parse",
      `${identities.controller}:.github/workflows/deep-quality.yml`,
    ])
  )
    throw new Error("Controller workflow bytes differ from the frozen commit");
  const binding = {
    ...identities,
    workflow_sha256: sha256(workflow),
    run: environment.GITHUB_RUN_ID,
    attempt: environment.GITHUB_RUN_ATTEMPT,
    runner: "ubuntu-24.04",
    architecture: environment.RUNNER_ARCH,
  };
  if (phase === "controller") {
    log(`Hosted local-check controller: ${JSON.stringify(binding)}`);
    return 0;
  }
  clean(sourceRoot, identities.source);
  for (const revision of [identities.base, identities.authority])
    if (git(sourceRoot, ["rev-parse", "--verify", `${revision}^{commit}`]) !== revision)
      throw new Error("Reviewed source authority revision is unavailable");
  if (git(sourceRoot, ["merge-base", identities.source, identities.base]) !== identities.mergeBase)
    throw new Error("Source merge-base differs from the reviewed plan");
  git(sourceRoot, ["merge-base", "--is-ancestor", identities.authority, identities.base]);
  const dependency = cargoDependencyBinding(
    environment.PORTCOVE_LOCAL_DEPENDENCY_BINDING,
    git,
    sourceRoot,
    identities,
  );
  const scriptChanges = git(sourceRoot, [
    "diff",
    "--name-only",
    identities.authority,
    identities.source,
    "--",
    "scripts",
    "apps/desktop/scripts",
  ])
    .split("\n")
    .filter(
      (name) => name && !name.endsWith(".test.mjs") && name !== "scripts/workflow-provenance.mjs",
    );
  if (scriptChanges.length > 0)
    throw new Error("Source changes trusted local-check script authority");
  if (
    git(sourceRoot, [
      "diff",
      "--raw",
      identities.authority,
      identities.source,
      "--",
      ...hostedLocalCheckAuthorityPaths.filter((name) => !dependency || name !== "Cargo.lock"),
    ]) !== ""
  )
    throw new Error("Source changes trusted local-check authority");
  const authorityTree = git(sourceRoot, [
    "ls-tree",
    identities.authority,
    "--",
    ...hostedLocalCheckAuthorityPaths,
  ]);
  const scriptTree = git(sourceRoot, [
    "ls-tree",
    "-r",
    identities.authority,
    "--",
    "scripts",
    "apps/desktop/scripts",
  ])
    .split("\n")
    .filter(
      (record) =>
        !record.endsWith(".test.mjs") && !record.endsWith("\tscripts/workflow-provenance.mjs"),
    )
    .join("\n");
  binding.authority_tree_sha256 = sha256(`${authorityTree}\n${scriptTree}`);
  if (dependency) {
    const lock = await readFile(path.join(sourceRoot, "Cargo.lock"));
    if (sha256(lock) !== dependency.lock_sha256)
      throw new Error("Reviewed dependency lock digest differs");
    binding.dependency = dependency;
  }
  const rustPin = (await readFile(path.join(sourceRoot, "rust-toolchain.toml"), "utf8")).match(
    /^channel = "([^"]+)"$/mu,
  )?.[1];
  if (!/^\d+\.\d+\.\d+$/u.test(rustPin ?? "")) throw new Error("Source Rust pin is invalid");
  const child = hostedLocalCheckEnvironment(environment, rustPin, sourceRoot);
  git(sourceRoot, ["update-ref", "refs/remotes/origin/main", identities.base]);
  if (git(sourceRoot, ["rev-parse", "origin/main"]) !== identities.base)
    throw new Error("Default local-check comparison target was not bound");
  log(`Hosted local-check source binding: ${JSON.stringify(binding)}`);
  if (phase === "prepare") return 0;
  const nodePin = (await readFile(path.join(sourceRoot, ".node-version"), "utf8")).trim();
  const packageManager = JSON.parse(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
  ).packageManager;
  const tools = JSON.parse(
    await readFile(path.join(sourceRoot, ".github/quality-tools.json"), "utf8"),
  );
  const justPin = tools.tools.find((tool) => tool.id === "just")?.version;
  if (
    process.version !== `v${nodePin}` ||
    invoke("just", ["--version"], sourceRoot) !== `just ${justPin}` ||
    rustVersion(invoke("rustc", ["--version"], sourceRoot), "rustc") !== rustPin ||
    rustVersion(invoke("cargo", ["--version"], sourceRoot), "cargo") !== rustPin ||
    invoke("pnpm", ["--version"], sourceRoot) !== packageManager.replace(/^pnpm@/u, "")
  )
    throw new Error("Observed local-check tools differ from repository pins");
  log(
    `Local-check execution: ${JSON.stringify({
      command: ["just", "local-check", "--fresh"],
      node: process.version,
      just: justPin,
      rust: rustPin,
      package_manager: packageManager,
      environment: {
        CI: null,
        CARGO_BUILD_JOBS: "4",
        CARGO_INCREMENTAL: null,
        RUSTUP_TOOLCHAIN: null,
        CARGO_PROFILE_DEV_DEBUG: null,
        CARGO_PROFILE_TEST_DEBUG: null,
        RUSTFLAGS: null,
        RUSTDOCFLAGS: null,
        CARGO_BUILD_TARGET: null,
        NODE_OPTIONS: null,
        PORTCOVE_TEST_FIXTURES: null,
      },
    })}`,
  );
  const execute = options.spawn ?? spawnSync;
  const plan = execute("just", ["local-check", "--plan"], {
    cwd: sourceRoot,
    env: child,
    stdio: "inherit",
  });
  if (plan.error) throw plan.error;
  if (plan.status !== 0) return plan.status ?? 1;
  const result = execute("just", ["local-check", "--fresh"], {
    cwd: sourceRoot,
    env: child,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  log(`Local-check command exit: ${status}`);
  clean(controllerRoot, identities.controller);
  clean(sourceRoot, identities.source);
  if (dependency) {
    cargoDependencyBinding(
      environment.PORTCOVE_LOCAL_DEPENDENCY_BINDING,
      git,
      sourceRoot,
      identities,
    );
    if (sha256(await readFile(path.join(sourceRoot, "Cargo.lock"))) !== dependency.lock_sha256)
      throw new Error("Reviewed dependency lock changed during execution");
  }
  if (git(sourceRoot, ["rev-parse", "origin/main"]) !== identities.base)
    throw new Error("Local-check comparison target changed during execution");
  if (status === 0) log(`Hosted local-check completed: ${JSON.stringify(binding)}`);
  return status;
}

function cohortInputs(record) {
  return {
    workflow: record.workflow,
    checkout: record.checkout,
    validation: record.validation,
    desired: record.desired,
    observed: record.observed,
    job_toolchains: record.job_toolchains,
  };
}

function command(commandName, args, cwd = root) {
  return execFileSync(commandName, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  }).trim();
}

function rustVersion(value, commandName) {
  const match = new RegExp(`^${commandName} (\\d+\\.\\d+\\.\\d+)\\b`, "u").exec(value);
  if (!match) throw new Error(`Unable to parse observed ${commandName} version`);
  return match[1];
}

function observedMatch(desired, observed) {
  if (observed === null) return null;
  return (
    typeof desired === "string" &&
    desired.length > 0 &&
    typeof observed === "string" &&
    observed.length > 0 &&
    desired === observed
  );
}

export function buildWorkflowProvenance({
  workflow,
  callerWorkflow = workflow,
  mode,
  desiredRunner,
  workflowContents,
  desired,
  observed,
  environment,
  checkoutSha,
  validationPlanDigest = environment.PORTCOVE_PLAN_DIGEST,
  validationPlanMode = environment.PORTCOVE_PLAN_MODE,
  caller = environment.PORTCOVE_CALLER ?? environment.GITHUB_EVENT_NAME,
}) {
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/u.test(workflow)) throw new Error("Invalid workflow filename");
  if (!/^[A-Za-z0-9._-]+\.ya?ml$/u.test(callerWorkflow))
    throw new Error("Invalid caller workflow filename");
  if (!exactSha(environment.GITHUB_WORKFLOW_SHA))
    throw new Error("GITHUB_WORKFLOW_SHA must identify the workflow-file source commit");
  if (!exactSha(environment.GITHUB_SHA))
    throw new Error("GITHUB_SHA must identify the triggering workflow commit");
  const headSha = environment.PORTCOVE_HEAD_SHA || environment.GITHUB_SHA;
  if (!exactSha(headSha)) throw new Error("PORTCOVE_HEAD_SHA must identify the source-code head");
  if (!exactSha(checkoutSha)) throw new Error("Checked-out code SHA is unavailable");
  if (!exactPositiveInteger(environment.GITHUB_RUN_ID)) throw new Error("Invalid GITHUB_RUN_ID");
  if (!exactPositiveInteger(environment.GITHUB_RUN_ATTEMPT))
    throw new Error("Invalid GITHUB_RUN_ATTEMPT");
  if (!/^[a-f0-9]{64}$/u.test(validationPlanDigest ?? ""))
    throw new Error("validation plan digest must be exact");
  if (!["fast", "prose", "qualification"].includes(validationPlanMode))
    throw new Error("validation plan mode is invalid");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(caller ?? ""))
    throw new Error("workflow caller identity is invalid");
  const expectedRefPrefix = `${environment.GITHUB_REPOSITORY}/.github/workflows/${callerWorkflow}@`;
  if (!environment.GITHUB_WORKFLOW_REF?.startsWith(expectedRefPrefix))
    throw new Error("GITHUB_WORKFLOW_REF does not identify the selected repository workflow");
  if (checkoutSha !== environment.GITHUB_SHA)
    throw new Error("Checked-out code does not match GITHUB_SHA");
  const matches = {
    node: observedMatch(desired.node, observed.node),
    package_manager: observedMatch(desired.package_manager, observed.package_manager),
    rust: observedMatch(desired.rust, observed.rust),
    cargo: observedMatch(desired.rust, observed.cargo),
    build_configuration:
      JSON.stringify(desired.build_configuration) === JSON.stringify(observed.build_configuration),
  };
  if (Object.values(matches).includes(false))
    throw new Error(
      `Observed workflow configuration differs from desired: ${JSON.stringify(matches)}`,
    );
  const record = {
    format_version: 4,
    run: {
      id: Number(environment.GITHUB_RUN_ID),
      attempt: Number(environment.GITHUB_RUN_ATTEMPT),
      event: environment.GITHUB_EVENT_NAME,
    },
    workflow: {
      caller_path: `.github/workflows/${callerWorkflow}`,
      caller_ref: environment.GITHUB_WORKFLOW_REF,
      source_sha: environment.GITHUB_WORKFLOW_SHA,
      called_path: `.github/workflows/${workflow}`,
      called_source_sha: checkoutSha,
      content_sha256: sha256(workflowContents),
    },
    checkout: { sha: checkoutSha, github_sha: environment.GITHUB_SHA, head_sha: headSha },
    validation: {
      plan_digest: validationPlanDigest,
      mode: validationPlanMode,
      caller,
    },
    desired: { runner: desiredRunner, mode, ...desired },
    observed,
    matches,
    job_toolchains: [
      {
        job: environment.GITHUB_JOB ?? "provenance",
        runner: observed.runner,
        node: observed.node,
        package_manager: observed.package_manager,
        rust: observed.rust,
        cargo: observed.cargo,
      },
    ],
  };
  return { ...record, equivalent_cohort: sha256(JSON.stringify(cohortInputs(record))) };
}

export function parseProvenanceArchive(archive) {
  if (!Buffer.isBuffer(archive) || archive.length < 22 || archive.length > 2 * 1024 * 1024)
    throw new Error("Invalid provenance artifact archive size");
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("Missing provenance artifact ZIP directory");
  const entries = archive.readUInt16LE(end + 10);
  const directoryOffset = archive.readUInt32LE(end + 16);
  let cursor = directoryOffset;
  const matches = [];
  for (let index = 0; index < entries; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Malformed provenance artifact ZIP directory");
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === "workflow-provenance.json") {
      if (flags & 1) throw new Error("Encrypted provenance artifacts are unsupported");
      if (![0, 8].includes(method) || uncompressedSize > 1024 * 1024)
        throw new Error("Unsupported provenance artifact compression");
      if (archive.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error("Malformed provenance artifact ZIP entry");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      const contents = method === 0 ? compressed : inflateRawSync(compressed);
      if (contents.length !== uncompressedSize)
        throw new Error("Provenance artifact size mismatch");
      matches.push(contents);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (matches.length !== 1) throw new Error("Provenance artifact must contain one JSON record");
  return JSON.parse(matches[0].toString("utf8"));
}

export function validateWorkflowProvenance(
  record,
  { runId, attempt, headSha, repository, workflow, calledWorkflow = workflow, event },
) {
  const expectedPath = `.github/workflows/${workflow}`;
  const expectedCalledPath = `.github/workflows/${calledWorkflow}`;
  const expectedRefPrefix = `${repository}/${expectedPath}@`;
  const desired = record?.desired;
  const observed = record?.observed;
  const expectedMatches = {
    node: observedMatch(desired?.node, observed?.node),
    package_manager: observedMatch(desired?.package_manager, observed?.package_manager),
    rust: observedMatch(desired?.rust, observed?.rust),
    cargo: observedMatch(desired?.rust, observed?.cargo),
    build_configuration:
      JSON.stringify(desired?.build_configuration) ===
      JSON.stringify(observed?.build_configuration),
  };
  const expectedCohort = sha256(JSON.stringify(cohortInputs(record ?? {})));
  if (
    record?.format_version !== 4 ||
    record.run?.id !== runId ||
    record.run?.attempt !== attempt ||
    record.run?.event !== event ||
    record.workflow?.caller_path !== expectedPath ||
    !record.workflow?.caller_ref?.startsWith(expectedRefPrefix) ||
    record.workflow?.called_path !== expectedCalledPath ||
    record.workflow?.called_source_sha !== record.checkout?.sha ||
    record.checkout?.head_sha !== headSha ||
    !exactSha(record.checkout?.sha) ||
    record.checkout?.github_sha !== record.checkout.sha ||
    !/^[a-f0-9]{64}$/u.test(record.validation?.plan_digest ?? "") ||
    !["fast", "prose", "qualification"].includes(record.validation?.mode) ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(record.validation?.caller ?? "") ||
    !exactSha(record.workflow?.source_sha) ||
    !/^[a-f0-9]{64}$/u.test(record.workflow?.content_sha256 ?? "") ||
    !["ci", "release"].includes(desired?.mode) ||
    typeof desired?.runner !== "string" ||
    desired.runner.length === 0 ||
    ![desired?.node, desired?.package_manager, desired?.rust].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    ![observed?.node, observed?.package_manager, observed?.rust, observed?.cargo].every(
      (value) => value === null || (typeof value === "string" && value.length > 0),
    ) ||
    typeof observed?.runner?.os !== "string" ||
    observed.runner.os.length === 0 ||
    typeof observed?.runner?.architecture !== "string" ||
    observed.runner.architecture.length === 0 ||
    !Array.isArray(record.job_toolchains) ||
    record.job_toolchains.length === 0 ||
    record.job_toolchains.some(
      (job) =>
        typeof job?.job !== "string" ||
        job.job.length === 0 ||
        typeof job?.runner?.os !== "string" ||
        typeof job?.runner?.architecture !== "string" ||
        ![job.node, job.package_manager, job.rust, job.cargo].some(
          (value) => typeof value === "string" && value.length > 0,
        ),
    ) ||
    JSON.stringify(record.matches) !== JSON.stringify(expectedMatches) ||
    Object.values(expectedMatches).some((matches) => matches === false) ||
    record.equivalent_cohort !== expectedCohort
  )
    throw new Error("Provenance artifact identity or configuration mismatch");
  return record;
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === "hosted-local-check") {
    if (args.length !== 2) throw new Error("hosted-local-check accepts only one fixed phase");
    process.exitCode = await runHostedLocalCheck(args[1]);
    return;
  }
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      workflow: { type: "string" },
      "caller-workflow": { type: "string" },
      mode: { type: "string" },
      runner: { type: "string" },
      output: { type: "string" },
      "observed-toolchains": { type: "string", default: "all" },
    },
  });
  if (
    !values.workflow ||
    !["ci", "release"].includes(values.mode) ||
    !values.runner ||
    !values.output
  )
    throw new Error(
      "Usage: workflow-provenance --workflow FILE --mode ci|release --runner LABEL --output FILE",
    );
  const node = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const repositoryPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const rustToolchain = (await readFile(path.join(root, "rust-toolchain.toml"), "utf8")).match(
    /^channel = "([^"]+)"$/mu,
  )?.[1];
  if (!rustToolchain) throw new Error("Unable to read desired Rust toolchain");
  const expectedBuildConfiguration = {
    ci: true,
    cargo_profile_dev_debug: values.mode === "ci" ? "line-tables-only" : null,
    cargo_profile_test_debug: values.mode === "ci" ? "line-tables-only" : null,
  };
  if (!["all", "node"].includes(values["observed-toolchains"]))
    throw new Error("observed toolchains must be all or node");
  const observeAll = values["observed-toolchains"] === "all";
  const packageManagerVersion = observeAll ? command("pnpm", ["--version"], root) : null;
  const record = buildWorkflowProvenance({
    workflow: values.workflow,
    callerWorkflow: values["caller-workflow"] ?? values.workflow,
    mode: values.mode,
    desiredRunner: values.runner,
    workflowContents: await readFile(path.join(root, ".github/workflows", values.workflow)),
    desired: {
      node,
      package_manager: repositoryPackage.packageManager.replace(/^pnpm@/u, ""),
      rust: rustToolchain,
      build_configuration: expectedBuildConfiguration,
    },
    observed: {
      node: process.version.replace(/^v/u, ""),
      package_manager: packageManagerVersion,
      rust: observeAll ? rustVersion(command("rustc", ["--version"]), "rustc") : null,
      cargo: observeAll ? rustVersion(command("cargo", ["--version"]), "cargo") : null,
      runner: {
        os: process.env.RUNNER_OS,
        architecture: process.env.RUNNER_ARCH,
      },
      build_configuration: {
        ci: process.env.CI === "true",
        cargo_profile_dev_debug: process.env.CARGO_PROFILE_DEV_DEBUG ?? null,
        cargo_profile_test_debug: process.env.CARGO_PROFILE_TEST_DEBUG ?? null,
      },
    },
    environment: process.env,
    checkoutSha: command("git", ["rev-parse", "HEAD"]),
  });
  await writeFile(path.resolve(values.output), `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(`Recorded workflow provenance cohort ${record.equivalent_cohort}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
