#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { errorCode, errorMessage, isRecord } from "./runtime-values.mts";
import type { BinaryLike } from "node:crypto";
import type { SpawnSyncOptions } from "node:child_process";

export interface SelectedObligationCommand {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
}
export type HostedOperation =
  | "bootstrap"
  | "selected"
  | "compiled"
  | "qualification-history"
  | "candidate-consumer";
interface BindingIdentity {
  source: string;
  base: string;
  mergeBase: string;
  controller: string;
  authority: string;
}
interface CandidateConsumer {
  controller_tree: string;
  product_source: string;
  product_tree: string;
  source_tree: string;
}
interface HostedBindingBase {
  format_version: 1;
  source: string;
  base: string;
  merge_base: string;
  controller: string;
  authority: string;
  inventory_sha256: string;
  plan_digest: string;
  selected_plan: SelectedObligationCommand[];
  baseline_plan: SelectedObligationCommand[];
}
export type HostedValidationBinding = HostedBindingBase &
  (
    | { operation: "candidate-consumer"; consumer: CandidateConsumer }
    | { operation: Exclude<HostedOperation, "candidate-consumer"> }
  );
export interface CargoDependencySpecification {
  package: string;
  from_version: string;
  to_version: string;
  from_checksum: string;
  to_checksum: string;
  lock_sha256: string;
  manifests: { path: string; section: string }[];
}
export type HostedCommand = (commandName: string, args: readonly string[], cwd: string) => string;
export interface HostedSpawnResult {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
  signal?: string | null;
  error?: NodeJS.ErrnoException;
}
export interface HostedExecutionOptions {
  environment?: NodeJS.ProcessEnv;
  controllerRoot?: string;
  command?: HostedCommand;
  log?: (message: string) => void;
  spawn?: (
    commandName: string,
    args: readonly string[],
    options: SpawnSyncOptions,
  ) => HostedSpawnResult;
}
export interface ProvenanceBuildConfiguration {
  ci: boolean;
  cargo_profile_dev_debug?: string | null;
  cargo_profile_test_debug?: string | null;
}
export interface ProvenanceDesired {
  node: string;
  package_manager: string;
  rust: string;
  build_configuration: unknown;
}
export interface ProvenanceObserved {
  node: string | null;
  package_manager: string | null;
  rust: string | null;
  cargo: string | null;
  runner: { os: string | undefined; architecture: string | undefined };
  build_configuration: unknown;
}
export interface WorkflowProvenance {
  format_version: 4;
  run: { id: number; attempt: number; event: string | undefined };
  workflow: {
    caller_path: string;
    caller_ref: string;
    source_sha: string;
    called_path: string;
    called_source_sha: string;
    content_sha256: string;
  };
  checkout: { sha: string; github_sha: string; head_sha: string };
  validation: { plan_digest: string; mode: string; caller: string };
  desired: ProvenanceDesired & { runner: string; mode: string };
  observed: ProvenanceObserved;
  matches: {
    node: boolean | null;
    package_manager: boolean | null;
    rust: boolean | null;
    cargo: boolean | null;
    build_configuration: boolean;
  };
  job_toolchains: {
    job: string;
    runner: ProvenanceObserved["runner"];
    node?: unknown;
    package_manager?: unknown;
    rust?: unknown;
    cargo?: unknown;
  }[];
  equivalent_cohort: string;
}
export interface ProvenanceBuildOptions {
  workflow: string;
  callerWorkflow?: string;
  mode: string;
  desiredRunner: string;
  workflowContents: BinaryLike;
  desired: ProvenanceDesired;
  observed: ProvenanceObserved;
  environment: NodeJS.ProcessEnv;
  checkoutSha: string;
  validationPlanDigest?: string;
  validationPlanMode?: string;
  caller?: string;
}
export interface ProvenanceValidationContext {
  runId: number;
  attempt: number;
  headSha: string;
  repository: string;
  workflow: string;
  calledWorkflow?: string;
  event: string;
}
function parsedPackageManager(contents: string): string {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || typeof value.packageManager !== "string")
    throw new Error("Repository package-manager pin is invalid");
  return value.packageManager;
}
function parsedJustPin(contents: string): string | undefined {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || !Array.isArray(value.tools))
    throw new Error("Repository quality-tool pins are invalid");
  const tools: unknown[] = value.tools;
  const just = tools.find((tool) => isRecord(tool) && tool.id === "just");
  if (just === undefined) return undefined;
  if (!isRecord(just) || typeof just.version !== "string")
    throw new Error("Repository just pin is invalid");
  return just.version;
}
const root = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");
const exactSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const exactPositiveInteger = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d*$/u.test(value);

// The fixed local recipe's selection, execution, containment and tool authorities.
// This transport rejects authority changes; it cannot qualify a changed selector.
export const hostedLocalCheckAuthorityPaths = Object.freeze([
  "AGENTS.md",
  ".gitattributes",
  ".gitmodules",
  "deny.toml",
  "docs/QUALITY.md",
  "justfile",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".node-version",
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/vite.config.ts",
  "apps/desktop/tsconfig.json",
  "tsconfig.base.json",
  "apps/desktop/stylelint.config.mjs",
  "scripts/tsconfig.json",
  "apps/desktop/scripts/tsconfig.json",
  "apps/desktop/test/tsconfig.json",
  "apps/desktop/public/tsconfig.json",
  "integrations/playnite/tsconfig.json",
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
  "scripts/local-validation.mts",
  "scripts/ordinary-validation.mts",
  "scripts/validation-evidence.mts",
  "scripts/checked-git.mts",
  "scripts/resource-status.mts",
  "scripts/resource-capacity.mts",
  "scripts/resource-paths.mts",
  "scripts/resource-command.mts",
  "scripts/native-build.mts",

  "scripts/report-summary.mts",
  "scripts/native-session-lock.mts",
  "scripts/process-lock.mts",
  "scripts/validation-plan.mts",
  "scripts/audit.mts",
  "scripts/audit-evidence.mts",
  "scripts/audit-archive.mts",
  "scripts/audit-reuse.mts",
  "scripts/dev-storage.mts",
  "scripts/tool-cache.mts",
  "scripts/select-ci-plan.mts",
  "scripts/rust-test-impact.mts",
  "scripts/qualification-coverage.mts",
  "scripts/validation-platforms.mts",
  "vite.config.ts",
  "scripts/browser-traces.ts",
  "scripts/frontend-tests.ts",
  "scripts/run-ui-tests.mts",
  "scripts/run-viteplus.mts",
  "scripts/ui-test-selection.mts",
  "scripts/viteplus-cli.mts",
  "tsconfig.json",
  "scripts/run-rust-tests.mts",
  "scripts/heavy-rust-test-lock.mts",
  "scripts/rust-support-cache.mts",
  "scripts/rust-test-tree-supervisor.mts",
  "scripts/quality-tools.mts",
  "scripts/test-duration-reporter.mts",
  "scripts/bootstrap-quality-tools.sh",
  "scripts/install-linux-desktop-prerequisites.sh",
  "crates/portcove-core/src/testdata/host_tool_probe.rs.txt",
  "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
]);

export function isHostedLocalCheckScriptAuthority(name: string) {
  return (
    (name.startsWith("scripts/") || name.startsWith("apps/desktop/scripts/")) &&
    !/\.test\.[cm]?[jt]s$/u.test(name) &&
    name !== "scripts/workflow-provenance.mts"
  );
}

export function hostedLocalCheckEnvironment(
  environment: NodeJS.ProcessEnv,
  rustPin: string,
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

function hostedLocalCheckIdentities(environment: NodeJS.ProcessEnv): BindingIdentity {
  const fields = {
    source: environment.PORTCOVE_LOCAL_SOURCE_SHA,
    base: environment.PORTCOVE_LOCAL_BASE_SHA,
    mergeBase: environment.PORTCOVE_LOCAL_MERGE_BASE_SHA,
    controller: environment.PORTCOVE_LOCAL_CONTROLLER_SHA,
    authority: environment.PORTCOVE_LOCAL_AUTHORITY_SHA,
  };
  function assertIdentities(value: {
    [K in keyof BindingIdentity]: string | undefined;
  }): asserts value is BindingIdentity {
    for (const [name, sha] of Object.entries(value))
      if (!exactSha(sha)) throw new Error(`Exact ${name} SHA is required`);
  }
  assertIdentities(fields);
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
function cargoDependencyBinding(
  raw: string | undefined,
  git: (cwd: string, args: readonly string[]) => string,
  sourceRoot: string,
  identities: BindingIdentity,
) {
  if (!raw) return null;
  function fail(): never {
    throw new Error("Invalid reviewed Cargo dependency binding");
  }
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch {
    fail();
  }
  if (JSON.stringify(spec) !== raw) fail();
  function assertSpecification(value: unknown): asserts value is CargoDependencySpecification {
    if (!isRecord(value)) fail();
    const keys = [
      "package",
      "from_version",
      "to_version",
      "from_checksum",
      "to_checksum",
      "lock_sha256",
      "manifests",
    ];
    if (Object.keys(value).sort().join() !== keys.sort().join()) fail();
    if (typeof value.package !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(value.package)) fail();
    for (const key of ["from_version", "to_version"])
      if (
        typeof value[key] !== "string" ||
        !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value[key])
      )
        fail();
    for (const key of ["from_checksum", "to_checksum", "lock_sha256"])
      if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key])) fail();
    if (
      value.from_version === value.to_version ||
      !Array.isArray(value.manifests) ||
      value.manifests.length < 1 ||
      value.manifests.length > 2
    )
      fail();
    const seen = new Set(["Cargo.lock"]);
    for (const entry of value.manifests as unknown[]) {
      if (
        !isRecord(entry) ||
        Object.keys(entry).sort().join() !== "path,section" ||
        typeof entry.path !== "string" ||
        !cargoDependencyManifests.has(entry.path) ||
        seen.has(entry.path) ||
        typeof entry.section !== "string" ||
        !["dependencies", "dev-dependencies"].includes(entry.section)
      )
        fail();
      seen.add(entry.path);
    }
  }
  assertSpecification(spec);
  const paths = new Set(["Cargo.lock", ...spec.manifests.map((entry) => entry.path)]);
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
  const bytes = (revision: string, name: string) => {
    const tree = git(sourceRoot, ["ls-tree", revision, "--", name]);
    if (!/^100644 blob [a-f0-9]{40}\t/u.test(tree)) fail();
    const blob = execFileSync("git", ["show", `${revision}:${name}`], {
      cwd: sourceRoot,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = blob.toString("utf8");
    if (!Buffer.from(text).equals(blob)) fail();
    // A line scanner must never interpret table-shaped text inside TOML strings.
    // This profile intentionally accepts only the canonical single-line shapes.
    if (text.includes('"""') || text.includes("'''") || text.includes("\r")) fail();
    return text;
  };
  const before = bytes(identities.authority, "Cargo.lock");
  const after = bytes(identities.source, "Cargo.lock");
  const blocks = before.split(/(?=^\[\[package\]\]$)/mu);
  const matching = blocks.filter(
    (block: string) =>
      block.startsWith("[[package]]\n") &&
      block.split("\n").includes(`name = "${spec.package}"`) &&
      block.split("\n").includes(`version = "${spec.from_version}"`),
  );
  if (matching.length !== 1) fail();
  const block = matching[0];
  if (!block) fail();
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
        (value: string) =>
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
    const declaration = new RegExp(
      `^\\s*(?:${spec.package}|"${spec.package}"|'${spec.package}')\\s*=`,
      "u",
    );
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line === undefined) fail();
      if (/^\[/u.test(line)) section = line;
      if (line === `[${entry.section}]`) tables++;
      if (section === `[${entry.section}]` && declaration.test(line)) {
        declarations++;
        if (line === `${spec.package} = "${spec.from_version}"`) found = index;
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

// This projection is diagnostic only: it never supplies input to an acceptance predicate.
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
function describe(value: unknown) {
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return { type: "string", bytes: bytes.length, sha256: sha256(bytes) };
  }
  if (Array.isArray(value)) return { type: "array", count: value.length };
  return { type: value === null ? "null" : typeof value };
}
function allowedText(value: unknown, choices: readonly string[]) {
  return typeof value === "string" && choices.includes(value) ? value : undefined;
}
interface PreflightIdentity {
  source: unknown;
  base: unknown;
  mergeBase?: unknown;
  merge_base?: unknown;
}
function projectPreflightReport(report: unknown) {
  const audit = field(report, "pre_change_audit");
  const blocker = field(report, "blocker");
  const observation = field(blocker, "observation");
  const obligations = field(report, "obligations");
  const format = field(report, "format_version");
  const source = field(report, "source"),
    base = field(report, "base"),
    mergeBase = field(report, "merge_base"),
    digest = field(report, "plan_digest");
  return {
    format_version: typeof format === "number" ? format : describe(format),
    source: exactSha(source) ? source : describe(source),
    base: exactSha(base) ? base : describe(base),
    merge_base: exactSha(mergeBase) ? mergeBase : describe(mergeBase),
    plan_digest:
      typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest) ? digest : describe(digest),
    status:
      field(report, "status") === "planning-blocked"
        ? "planning-blocked"
        : describe(field(report, "status")),
    obligations: Array.isArray(obligations)
      ? (obligations as unknown[]).map((entry) => ({
          id: describe(field(entry, "id")),
          route:
            allowedText(field(entry, "route"), ["local", "blocked", "hosted-local-check"]) ??
            describe(field(entry, "route")),
          missing: describe(field(entry, "missing")),
        }))
      : describe(obligations),
    audit: {
      route:
        field(audit, "route") === "local-prerequisites-unverified"
          ? "local-prerequisites-unverified"
          : describe(field(audit, "route")),
      profile:
        allowedText(field(audit, "profile"), ["complete", "transition"]) ??
        describe(field(audit, "profile")),
      command_matches: field(audit, "command") === "just audit --profile transition --fresh",
      command_observation: describe(field(audit, "command")),
    },
    ...(field(blocker, "id") === "cargo-metadata" && observation
      ? {
          cargo: {
            reason:
              allowedText(field(observation, "reason"), [
                "spawn-error",
                "cargo-exit",
                "metadata-json",
                "package-inventory",
                "UNKNOWN",
              ]) ?? "UNKNOWN",
            status: Number.isInteger(field(observation, "status"))
              ? field(observation, "status")
              : null,
            code:
              allowedText(field(observation, "code"), [
                "ENOENT",
                "EACCES",
                "EPERM",
                "ETIMEDOUT",
                "ENOBUFS",
                "E2BIG",
                "EIO",
              ]) ?? "UNKNOWN",
          },
        }
      : {}),
  };
}
function emitPreflightRefusal(
  log: (text: string) => void,
  reason: string,
  result: HostedSpawnResult,
  identities: PreflightIdentity,
  report: unknown,
  elapsedMs: number,
) {
  try {
    const code = result.error?.code;
    const mergeBase = identities.mergeBase ?? identities.merge_base;
    const diagnostic = {
      format_version: 1,
      reason,
      expected: {
        source: exactSha(identities.source) ? identities.source : null,
        base: exactSha(identities.base) ? identities.base : null,
        merge_base: exactSha(mergeBase) ? mergeBase : null,
      },
      result: {
        status: Number.isInteger(result.status) ? result.status : null,
        signal:
          allowedText(result.signal, ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]) ??
          (result.signal == null ? null : "UNKNOWN"),
        code:
          allowedText(code, [
            "ENOENT",
            "EACCES",
            "EPERM",
            "ETIMEDOUT",
            "ENOBUFS",
            "E2BIG",
            "EIO",
          ]) ?? (code === undefined ? null : "UNKNOWN"),
        code_observation: describe(code),
        signal_observation: describe(result.signal),
      },
      elapsed_ms: Math.max(0, Math.round(elapsedMs)),
      capture_complete: !result.error && Number.isInteger(result.status) && result.signal == null,
      stdout: describe(result.stdout),
      stderr: describe(result.stderr),
      omitted: false,
      ...(report === undefined ? {} : { report: projectPreflightReport(report) }),
    };
    const prefix = "Hosted preflight refusal: ";
    let text = prefix + JSON.stringify(diagnostic);
    if (Buffer.byteLength(text + "\n") > 64 * 1024) {
      delete diagnostic.report;
      diagnostic.omitted = true;
      text = prefix + JSON.stringify(diagnostic);
    }
    if (Buffer.byteLength(text + "\n") <= 64 * 1024) log(text);
  } catch {
    /* Reporting/serialization failure must never mask the existing refusal. */
  }
}
function preflightReportReason(report: unknown, identities: PreflightIdentity) {
  if (field(report, "format_version") !== 1) return "format-version";
  if (field(report, "source") !== identities.source) return "source";
  if (field(report, "base") !== identities.base) return "base";
  if (field(report, "merge_base") !== (identities.mergeBase ?? identities.merge_base))
    return "merge-base";
  const digest = field(report, "plan_digest");
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return "plan-digest";
  if (field(report, "status") !== undefined) return "status";
  const obligations = field(report, "obligations");
  if (!Array.isArray(obligations)) return "obligations";
  if (obligations.length === 0) return "obligations-empty";
  const entries: unknown[] = obligations;
  if (entries.some((entry) => typeof field(entry, "id") !== "string" || field(entry, "id") === ""))
    return "obligation-id";
  if (new Set(entries.map((entry) => field(entry, "id"))).size !== entries.length)
    return "obligation-duplicate";
  return "prerequisites";
}
function hostedBrowserSelection(
  stdout: unknown,
  identities: BindingIdentity,
  exitStatus: number,
  reject: (reason: string, report?: unknown) => void = () => {},
) {
  const invalid = (reason: string, report?: unknown) => {
    reject(reason, report);
    return new Error("Invalid complete local-check preflight for provisioning");
  };
  let report: unknown;
  try {
    if (typeof stdout !== "string") throw new Error("Preflight output is not text");
    report = JSON.parse(stdout);
  } catch {
    throw invalid("json");
  }
  const digest = field(report, "plan_digest"),
    obligations = field(report, "obligations");
  if (
    field(report, "format_version") !== 1 ||
    field(report, "source") !== identities.source ||
    field(report, "base") !== identities.base ||
    field(report, "merge_base") !== identities.mergeBase ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    field(report, "status") !== undefined ||
    !Array.isArray(obligations) ||
    !obligations.length ||
    (obligations as unknown[]).some(
      (entry) => typeof field(entry, "id") !== "string" || field(entry, "id") === "",
    ) ||
    new Set((obligations as unknown[]).map((entry) => field(entry, "id"))).size !==
      obligations.length
  )
    throw invalid(preflightReportReason(report, identities), report);
  const entries: unknown[] = obligations;
  if (
    entries.some((entry) => {
      const missing = field(entry, "missing");
      return field(entry, "route") !== "local" || !Array.isArray(missing) || missing.length !== 0;
    })
  )
    throw invalid("prerequisites", report);
  // A policy preflight reports selection and the separate audit obligation together.
  // Acquisition cannot satisfy that audit, but its named routing disposition is
  // not a failure of the complete selected browser prerequisite observation.
  const audit = field(report, "pre_change_audit") ?? null;
  if (
    exitStatus !== 0 &&
    (exitStatus !== 1 ||
      field(audit, "route") !== "local-prerequisites-unverified" ||
      !allowedText(field(audit, "profile"), ["complete", "transition"]) ||
      field(audit, "command") !== "just audit --profile transition --fresh")
  )
    throw invalid("audit-exit", report);
  return {
    plan_digest: digest,
    browser: entries.some((entry) => field(entry, "id") === "ui-browser-tests"),
    pre_change_audit: audit,
  };
}

export async function runHostedLocalCheck(
  phase: string | undefined,
  options: HostedExecutionOptions = {},
) {
  if (!phase || !["controller", "prepare", "provision", "run"].includes(phase))
    throw new Error("hosted-local-check requires controller, prepare, provision or run");
  const environment = options.environment ?? process.env;
  const identities = hostedLocalCheckIdentities(environment);
  const controllerRoot = options.controllerRoot ?? root;
  const sourceRoot = path.resolve(controllerRoot, "../source");
  const invoke = options.command ?? command;
  const log = options.log ?? console.log;
  const git = (cwd: string, args: readonly string[]) => invoke("git", args, cwd);
  const clean = (cwd: string, expected: string) => {
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
  const binding: BindingIdentity & {
    workflow_sha256: string;
    run: string | undefined;
    attempt: string | undefined;
    runner: string;
    architecture: string | undefined;
    authority_tree_sha256?: string;
    dependency?: NonNullable<ReturnType<typeof cargoDependencyBinding>>;
  } = {
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
    .filter((name) => name && isHostedLocalCheckScriptAuthority(name));
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
      (record: string) =>
        !/\.test\.[cm]?[jt]s$/u.test(record) &&
        !record.endsWith("\tscripts/workflow-provenance.mts"),
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
  if (!rustPin || !/^\d+\.\d+\.\d+$/u.test(rustPin)) throw new Error("Source Rust pin is invalid");
  const child = hostedLocalCheckEnvironment(environment, rustPin, sourceRoot);
  git(sourceRoot, ["update-ref", "refs/remotes/origin/main", identities.base]);
  if (git(sourceRoot, ["rev-parse", "origin/main"]) !== identities.base)
    throw new Error("Default local-check comparison target was not bound");
  log(`Hosted local-check source binding: ${JSON.stringify(binding)}`);
  if (phase === "prepare") return 0;
  const nodePin = (await readFile(path.join(sourceRoot, ".node-version"), "utf8")).trim();
  const packageManager = parsedPackageManager(
    await readFile(path.join(sourceRoot, "package.json"), "utf8"),
  );
  const justPin = parsedJustPin(
    await readFile(path.join(sourceRoot, ".github/quality-tools.json"), "utf8"),
  );
  if (
    process.version !== `v${nodePin}` ||
    invoke("just", ["--version"], sourceRoot) !== `just ${justPin}` ||
    rustVersion(invoke("rustc", ["--version"], sourceRoot), "rustc") !== rustPin ||
    rustVersion(invoke("cargo", ["--version"], sourceRoot), "cargo") !== rustPin ||
    invoke("pnpm", ["--version"], sourceRoot) !== packageManager.replace(/^pnpm@/u, "")
  )
    throw new Error("Observed local-check tools differ from repository pins");
  const execute = options.spawn ?? spawnSync;
  if (phase === "provision") {
    const started = performance.now();
    const preflight = execute(
      process.execPath,
      ["scripts/local-validation.mts", "check", "--preflight", "--json"],
      {
        cwd: sourceRoot,
        env: child,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const refusal = (reason: string, report?: unknown) =>
      emitPreflightRefusal(log, reason, preflight, identities, report, performance.now() - started);
    if (preflight.error) {
      refusal("child-error");
      throw preflight.error;
    }
    if (preflight.status !== 0 && preflight.status !== 1) {
      refusal("child-status");
      return preflight.status ?? 1;
    }
    const selection = hostedBrowserSelection(
      preflight.stdout,
      identities,
      preflight.status,
      refusal,
    );
    const recheck = async () => {
      clean(controllerRoot, identities.controller);
      clean(sourceRoot, identities.source);
      if (git(sourceRoot, ["rev-parse", "origin/main"]) !== identities.base)
        throw new Error("Local-check comparison target changed during provisioning");
      if (dependency) {
        cargoDependencyBinding(
          environment.PORTCOVE_LOCAL_DEPENDENCY_BINDING,
          git,
          sourceRoot,
          identities,
        );
        if (sha256(await readFile(path.join(sourceRoot, "Cargo.lock"))) !== dependency.lock_sha256)
          throw new Error("Reviewed dependency lock changed during provisioning");
      }
    };
    await recheck();
    log(`Hosted browser selection: ${JSON.stringify({ ...binding, ...selection })}`);
    if (!selection.browser) return 0;
    const provision = execute("pnpm", ["--dir", "apps/desktop", "browser:bootstrap"], {
      cwd: sourceRoot,
      env: child,
      stdio: "inherit",
      timeout: 300_000,
    });
    if (provision.error) throw provision.error;
    await recheck();
    const status = provision.status ?? 1;
    if (status === 0)
      log(`Hosted browser provisioning completed: ${JSON.stringify({ ...binding, ...selection })}`);
    return status;
  }
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
  const plan = execute("just", ["local-check", "--plan"], {
    cwd: sourceRoot,
    env: child,
    stdio: "inherit",
  });
  if (plan.error) throw plan.error;
  if (plan.status !== 0) return plan.status ?? 1;
  // Planning can run Cargo metadata. Never execute a graph changed by discovery.
  clean(controllerRoot, identities.controller);
  clean(sourceRoot, identities.source);
  if (git(sourceRoot, ["rev-parse", "origin/main"]) !== identities.base)
    throw new Error("Local-check comparison target changed during planning");
  if (dependency) {
    cargoDependencyBinding(
      environment.PORTCOVE_LOCAL_DEPENDENCY_BINDING,
      git,
      sourceRoot,
      identities,
    );
    if (sha256(await readFile(path.join(sourceRoot, "Cargo.lock"))) !== dependency.lock_sha256)
      throw new Error("Reviewed dependency lock changed during planning");
  }
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

const bootstrapPaths = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/deep-quality.yml",
  ".github/workflows/native-design-compatibility.yml",
  "scripts/workflow-provenance.mts",
  "scripts/workflow-provenance.test.mts",
  "scripts/local-validation.mts",
  "scripts/ordinary-validation.mts",
  "scripts/validation-evidence.mts",
  "scripts/local-validation.test.mts",
  "scripts/native-backup-evidence.mts",
  "scripts/ci-workflow.test.mts",
  "scripts/check-catalog-repositories.test.mts",
  "scripts/check-retcomm-upstreams.test.mts",
  "scripts/deep-audit-summary.test.mts",
  "scripts/desktop-scenarios.mts",
  "scripts/desktop-scenarios.test.mts",
  "apps/desktop/scripts/desktop-test.mts",
  "apps/desktop/scripts/desktop-qualification-history-test.mts",
  "docs/NATIVE-HOSTED-ACCEPTANCE.md",
  "docs/DEVELOPMENT-TOOLS.md",
]);
const hostedOperations = new Set([
  "bootstrap",
  "selected",
  "compiled",
  "qualification-history",
  "candidate-consumer",
]);
const historyProductPaths = [
  "apps/desktop/src/components/DetailPanel.tsx",
  "apps/desktop/src/components/DetailQualificationSummary.test.tsx",
  "apps/desktop/src/components/DetailQualificationSummary.tsx",
  "apps/desktop/src/components/components.test.tsx",
];
const fixedWorkflow = ".github/workflows/native-design-compatibility.yml";
const fixedPhaseJobs: Readonly<Record<string, string | undefined>> = {
  selected: "hosted_selected",
  audit: "hosted_audit",
  compiled: "hosted_compiled",
  native: "hosted_history",
};

export function parseHostedValidationBinding(
  raw: unknown,
  digest: unknown,
): HostedValidationBinding {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 60_000 || sha256(raw) !== digest)
    throw new Error("Reviewed execution binding digest or size differs");
  const binding: unknown = JSON.parse(raw);
  function assertBinding(binding: unknown): asserts binding is HostedValidationBinding {
    if (!isRecord(binding)) throw new Error("Invalid reviewed execution binding");
    const keys = (
      "authority,base,baseline_plan,controller,format_version,inventory_sha256,merge_base,operation,plan_digest,selected_plan,source" +
      (binding.operation === "candidate-consumer" ? ",consumer" : "")
    )
      .split(",")
      .sort()
      .join();
    if (
      Object.keys(binding).sort().join() !== keys ||
      binding.format_version !== 1 ||
      typeof binding.operation !== "string" ||
      !hostedOperations.has(binding.operation) ||
      !["source", "controller", "base", "merge_base", "authority"].every((key) =>
        exactSha(binding[key]),
      ) ||
      !["inventory_sha256", "plan_digest"].every((key) => {
        const value = binding[key];
        return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
      }) ||
      !Array.isArray(binding.selected_plan) ||
      !Array.isArray(binding.baseline_plan)
    )
      throw new Error("Invalid reviewed execution binding");
    if (binding.operation === "bootstrap" && binding.source !== binding.controller)
      throw new Error("Bootstrap source must be the independently reviewed controller candidate");
    if (
      binding.operation === "candidate-consumer" &&
      (binding.source === binding.controller ||
        !isRecord(binding.consumer) ||
        Object.keys(binding.consumer).sort().join() !==
          "controller_tree,product_source,product_tree,source_tree" ||
        !Object.values(binding.consumer).every(exactSha))
    )
      throw new Error("Invalid independently reviewed candidate consumer composition");
    assertRetainedSelectedPlan(binding.baseline_plan, binding.selected_plan);
  }
  assertBinding(binding);
  return binding;
}

function assertSelectedPlan(plan: unknown): asserts plan is SelectedObligationCommand[] {
  if (!Array.isArray(plan) || !plan.length)
    throw new Error("Incomplete selected obligation inventory");
  const entries: unknown[] = plan;
  if (
    entries.some(
      (entry) =>
        !isRecord(entry) ||
        Object.keys(entry).sort().join() !== "args,cwd,executable,id" ||
        typeof entry.id !== "string" ||
        !entry.id ||
        typeof entry.executable !== "string" ||
        typeof entry.cwd !== "string" ||
        !Array.isArray(entry.args) ||
        entry.args.some((arg: unknown) => typeof arg !== "string"),
    )
  )
    throw new Error("Incomplete selected obligation inventory");
  if (
    new Set(entries.map((entry) => (isRecord(entry) ? entry.id : undefined))).size !==
    entries.length
  )
    throw new Error("Incomplete selected obligation inventory");
}
export function assertRetainedSelectedPlan(baseline: unknown, selected: unknown): void {
  assertSelectedPlan(baseline);
  assertSelectedPlan(selected);
  for (const expected of baseline) {
    const actual = selected.find((entry) => entry.id === expected.id);
    if (!actual || actual.executable !== expected.executable || actual.cwd !== expected.cwd)
      throw new Error(`Missing baseline selected obligation: ${expected.id}`);
    if (JSON.stringify(actual.args) !== JSON.stringify(expected.args))
      throw new Error(`Baseline selected arguments removed: ${expected.id}`);
  }
}

// Explicit execution-under-test admission. This never changes the old route's refusal
// or establishes that an unmerged controller is a trusted qualification authority.
export async function runHostedValidation(
  phase: string | undefined,
  options: HostedExecutionOptions = {},
) {
  const log = options.log ?? console.log;
  if (
    !phase ||
    !["controller", "prepare", "provision", "selected", "audit", "compiled", "native"].includes(
      phase,
    )
  )
    throw new Error("Unsupported fixed hosted phase");
  const env = options.environment ?? process.env;
  const binding = parseHostedValidationBinding(
    env.PORTCOVE_LOCAL_BINDING,
    env.PORTCOVE_LOCAL_BINDING_SHA256,
  );
  if (env.PORTCOVE_LOCAL_OPERATION !== binding.operation)
    throw new Error("Dispatch operation differs from the reviewed binding");
  const permitted: Record<HostedOperation, readonly string[]> = {
    bootstrap: ["prepare", "provision", "selected", "audit"],
    selected: ["prepare", "provision", "selected"],
    compiled: ["prepare", "compiled"],
    "qualification-history": ["prepare", "native"],
    "candidate-consumer": ["prepare", "provision", "selected", "compiled", "native"],
  };
  if (phase !== "controller" && !permitted[binding.operation].includes(phase))
    throw new Error("Phase differs from admitted operation");
  const admittedJobs = permitted[binding.operation]
    .map((entry) => fixedPhaseJobs[entry])
    .filter(Boolean);
  if (
    !admittedJobs.includes(env.GITHUB_JOB) ||
    (fixedPhaseJobs[phase] && fixedPhaseJobs[phase] !== env.GITHUB_JOB)
  )
    throw new Error("Fixed phase/job identity differs");
  if (
    env.GITHUB_REPOSITORY !== "boburning/portcove" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_SHA !== binding.controller ||
    env.GITHUB_WORKFLOW_SHA !== binding.controller ||
    !env.GITHUB_WORKFLOW_REF?.startsWith(`boburning/portcove/${fixedWorkflow}@`) ||
    env.RUNNER_OS !== "Linux" ||
    env.RUNNER_ARCH !== "X64" ||
    !exactPositiveInteger(env.GITHUB_RUN_ID) ||
    !exactPositiveInteger(env.GITHUB_RUN_ATTEMPT)
  )
    throw new Error("Reviewed workflow/run/runner identity differs");
  const controller = options.controllerRoot ?? root;
  const source = path.resolve(controller, "../source");
  const evidence = path.resolve(controller, "../hosted-evidence");
  const invoke = options.command ?? command;
  const git = (cwd: string, args: readonly string[]) => invoke("git", args, cwd);
  if (phase === "controller") {
    if (
      git(controller, ["rev-parse", "HEAD"]) !== binding.controller ||
      git(controller, ["status", "--porcelain=v1", "--untracked-files=all"])
    )
      throw new Error("Reviewed controller checkout differs");
    for (const name of [fixedWorkflow, "scripts/workflow-provenance.mts"])
      if (
        git(controller, ["hash-object", name]) !==
        git(controller, ["rev-parse", `${binding.controller}:${name}`])
      )
        throw new Error("Reviewed controller bytes differ");
    return 0;
  }
  const clean = () => {
    for (const [cwd, sha] of [
      [controller, binding.controller],
      [source, binding.source],
    ] as const)
      if (
        path.resolve(git(cwd, ["rev-parse", "--show-toplevel"])) !== path.resolve(cwd) ||
        git(cwd, ["rev-parse", "HEAD"]) !== sha ||
        git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])
      )
        throw new Error("Reviewed checkout is dirty or has a different identity");
  };
  clean();
  git(source, ["merge-base", "--is-ancestor", binding.authority, binding.base]);
  if (git(source, ["merge-base", binding.source, binding.base]) !== binding.merge_base)
    throw new Error("Reviewed merge-base differs");
  const names = git(source, [
    "diff",
    "--name-only",
    "--no-renames",
    binding.merge_base,
    binding.source,
  ])
    .split("\n")
    .filter(Boolean);
  const inventory = names.map((name: string) => {
    if (!/^[A-Za-z0-9_./-]+$/u.test(name) || name.split("/").includes(".."))
      throw new Error("Unsafe changed inventory path");
    const before = git(source, ["ls-tree", binding.merge_base, "--", name]);
    const after = git(source, ["ls-tree", binding.source, "--", name]);
    if (
      [before, after]
        .filter(Boolean)
        .some((entry) => !/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(entry))
    )
      throw new Error("Non-regular changed inventory input");
    return { path: name, base: before, source: after };
  });
  if (sha256(JSON.stringify(inventory)) !== binding.inventory_sha256)
    throw new Error("Complete reviewed changed inventory differs");
  const authorityChanges = git(source, [
    "diff",
    "--name-only",
    "--no-renames",
    binding.authority,
    binding.source,
  ])
    .split("\n")
    .filter(Boolean);
  if (binding.operation === "bootstrap") {
    if (authorityChanges.some((name) => !bootstrapPaths.has(name)))
      throw new Error("Bootstrap exceeds the independently admitted fifteen-path scope");
  } else if (binding.operation === "candidate-consumer") {
    const diff = (before: string, after: string) =>
      git(source, ["diff", "--name-only", "--no-renames", before, after])
        .split("\n")
        .filter(Boolean);
    git(source, ["merge-base", "--is-ancestor", binding.base, binding.controller]);
    git(source, ["merge-base", "--is-ancestor", binding.controller, binding.source]);
    if (diff(binding.authority, binding.controller).some((name) => !bootstrapPaths.has(name)))
      throw new Error("Candidate controller exceeds the independently admitted fifteen-path scope");
    const productBase = git(source, ["merge-base", binding.base, binding.consumer.product_source]);
    for (const changes of [
      diff(binding.controller, binding.source),
      diff(productBase, binding.consumer.product_source),
    ])
      if (JSON.stringify(changes) !== JSON.stringify(historyProductPaths))
        throw new Error("Candidate consumer must compose exactly the four reviewed product paths");
    for (const [commit, expected] of [
      [binding.controller, binding.consumer.controller_tree],
      [binding.source, binding.consumer.source_tree],
      [binding.consumer.product_source, binding.consumer.product_tree],
    ] as const)
      if (git(source, ["rev-parse", `${commit}^{tree}`]) !== expected)
        throw new Error("Candidate consumer tree differs from the independently reviewed binding");
    for (const name of historyProductPaths) {
      const product = git(source, ["ls-tree", binding.consumer.product_source, "--", name]);
      if (
        !/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(product) ||
        git(source, ["ls-tree", binding.source, "--", name]) !== product
      )
        throw new Error("Candidate consumer product bytes differ from the reviewed product source");
    }
  } else {
    git(source, ["merge-base", "--is-ancestor", binding.controller, binding.base]);
    if (
      authorityChanges.some(
        (name) =>
          hostedLocalCheckAuthorityPaths.includes(name) ||
          (isHostedLocalCheckScriptAuthority(name) &&
            name !== "apps/desktop/scripts/adapter-conformance.mts"),
      )
    )
      throw new Error("Unrelated executable or trusted selected authority changed");
    if (
      git(source, ["rev-parse", `${binding.source}:scripts/workflow-provenance.mts`]) !==
      git(controller, ["rev-parse", `${binding.controller}:scripts/workflow-provenance.mts`])
    )
      throw new Error("Source controller differs from the separately reviewed controller");
  }
  const preserved = [
    "scripts/audit.mts",
    "scripts/validation-evidence.mts",
    "justfile",
    "rust-toolchain.toml",
    ".node-version",
    "package.json",
    "apps/desktop/package.json",
    "Cargo.toml",
    "Cargo.lock",
    "pnpm-lock.yaml",
    "aqua.yaml",
    "aqua-checksums.json",
    ".github/quality-tools.json",
    ".config/nextest.toml",
    "scripts/run-rust-tests.mts",
    "scripts/heavy-rust-test-lock.mts",
    "scripts/resource-capacity.mts",
    "scripts/resource-paths.mts",
    "scripts/resource-command.mts",
    "scripts/native-build.mts",
    "scripts/fallow-source.mts",
    "scripts/process-lock.mts",
    "scripts/native-session-lock.mts",
    "scripts/rust-test-tree-supervisor.mts",
    "scripts/rust-test-impact.mts",
    "scripts/dev-storage.mts",
    "scripts/bootstrap-quality-tools.sh",
    "scripts/install-linux-desktop-prerequisites.sh",
  ];
  if (git(source, ["diff", "--name-only", binding.authority, binding.source, "--", ...preserved]))
    throw new Error("Bootstrap changed preserved recipes, pins, resources or containment");
  for (const name of [
    fixedWorkflow,
    "scripts/workflow-provenance.mts",
    "scripts/native-backup-evidence.mts",
  ])
    if (
      git(controller, ["hash-object", name]) !==
      git(controller, ["rev-parse", `${binding.controller}:${name}`])
    )
      throw new Error("Reviewed controller bytes changed");
  const rustPin = (await readFile(path.join(source, "rust-toolchain.toml"), "utf8")).match(
    /^channel = "([^"]+)"$/mu,
  )?.[1];
  if (!rustPin || !/^\d+\.\d+\.\d+$/u.test(rustPin)) throw new Error("Invalid Rust pin");
  const child = hostedLocalCheckEnvironment(env, rustPin, source);
  git(source, ["update-ref", "refs/remotes/origin/main", binding.base]);
  await mkdir(evidence, { recursive: true });
  const receipt = {
    ...binding,
    binding_sha256: env.PORTCOVE_LOCAL_BINDING_SHA256,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    job: env.GITHUB_JOB,
    phase,
    source_tree: git(source, ["rev-parse", `${binding.source}^{tree}`]),
    controller_tree: git(controller, ["rev-parse", `${binding.controller}^{tree}`]),
    workflow_sha256: sha256(await readFile(path.join(controller, fixedWorkflow))),
  };
  await writeFile(path.join(evidence, "binding.json"), JSON.stringify(receipt, null, 2) + "\n");
  if (phase === "prepare") return 0;
  const nodePin = (await readFile(path.join(source, ".node-version"), "utf8")).trim();
  const manager = parsedPackageManager(await readFile(path.join(source, "package.json"), "utf8"));
  const just = parsedJustPin(
    await readFile(path.join(source, ".github/quality-tools.json"), "utf8"),
  );
  if (
    process.version !== `v${nodePin}` ||
    invoke("just", ["--version"], source) !== `just ${just}` ||
    invoke("pnpm", ["--version"], source) !== manager.replace(/^pnpm@/u, "") ||
    rustVersion(invoke("rustc", ["--version"], source), "rustc") !== rustPin ||
    rustVersion(invoke("cargo", ["--version"], source), "cargo") !== rustPin
  )
    throw new Error("Observed execution tools differ from preserved pins");
  const execute = options.spawn ?? spawnSync;
  if (["provision", "selected"].includes(phase)) {
    const started = performance.now();
    const planned = execute(
      process.execPath,
      ["scripts/local-validation.mts", "check", "--preflight", "--json"],
      { cwd: source, env: child, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const refusal = (reason: string, report?: unknown) =>
      emitPreflightRefusal(log, reason, planned, binding, report, performance.now() - started);
    if (planned.error) {
      refusal("child-error");
      throw planned.error;
    }
    if (planned.status !== 0 && planned.status !== 1) {
      refusal("child-status");
      throw new Error("Complete candidate-root planning failed");
    }
    let report: unknown;
    try {
      if (typeof planned.stdout !== "string") throw new Error("Preflight output is not text");
      report = JSON.parse(planned.stdout);
    } catch (error) {
      refusal("json");
      throw error;
    }
    await writeFile(
      path.join(evidence, "selected-plan.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    let mismatch;
    try {
      if (!isRecord(report)) throw new Error("Preflight report is not an object");
      mismatch =
        report.source !== binding.source ||
        report.base !== binding.base ||
        report.merge_base !== binding.merge_base ||
        report.plan_digest !== binding.plan_digest ||
        JSON.stringify(report.selected_plan) !== JSON.stringify(binding.selected_plan) ||
        !Array.isArray(report.obligations) ||
        report.obligations.some((entry: unknown) => {
          const missing = field(entry, "missing");
          if (!Array.isArray(missing))
            throw new Error("Preflight prerequisite list is not an array");
          return missing.length;
        });
    } catch (error) {
      refusal("report-evaluation", report);
      throw error;
    }
    if (!isRecord(report)) throw new Error("Preflight report is not an object");
    if (mismatch) {
      const reason =
        report.source !== binding.source
          ? "source"
          : report.base !== binding.base
            ? "base"
            : report.merge_base !== binding.merge_base
              ? "merge-base"
              : report.plan_digest !== binding.plan_digest
                ? "plan-digest"
                : JSON.stringify(report.selected_plan) !== JSON.stringify(binding.selected_plan)
                  ? "selected-plan"
                  : !Array.isArray(report.obligations)
                    ? "obligations"
                    : "prerequisites";
      refusal(reason, report);
      throw new Error("Full reviewed selected plan or prerequisites differ");
    }
    clean();
    if (phase === "provision") {
      if (!Array.isArray(report.obligations))
        throw new Error("Preflight obligations are not an array");
      if (!report.obligations.some((entry: unknown) => field(entry, "id") === "ui-browser-tests"))
        return 0;
      const result = execute("pnpm", ["--dir", "apps/desktop", "browser:bootstrap"], {
        cwd: source,
        env: child,
        stdio: "inherit",
        timeout: 300_000,
      });
      clean();
      if (result.error) throw result.error;
      return result.status ?? 1;
    }
  }
  const commands: Record<string, [string, string[]] | undefined> = {
    selected: ["just", ["local-check", "--fresh"]],
    audit: ["just", ["audit", "--fresh"]],
    compiled: ["pnpm", ["--dir", "apps/desktop", "test:adapter-conformance"]],
    native: [
      "xvfb-run",
      [
        "-a",
        "dbus-run-session",
        "--",
        "pnpm",
        "--dir",
        "apps/desktop",
        "test:desktop",
        "--app",
        path.join(source, "target", "debug", "portcove-desktop"),
        "--driver",
        phase === "native" ? invoke("which", ["tauri-driver"], source) : "",
        "--native-driver",
        phase === "native" ? invoke("which", ["WebKitWebDriver"], source) : "",
        "--output",
        path.join(evidence, "native"),
        "--scenario",
        "native-qualification-history",
      ],
    ],
  };
  const selectedCommand = commands[phase ?? ""];
  if (!selectedCommand) throw new Error("Unsupported fixed hosted phase");
  const [executable, args] = selectedCommand;
  // No command parameters are supplied by the candidate or dispatch caller.
  const stdout = await open(path.join(evidence, "stdout.log"), "wx");
  const stderr = await open(path.join(evidence, "stderr.log"), "wx");
  let result;
  const started = new Date().toISOString();
  try {
    result = execute(executable, args, {
      cwd: source,
      env: {
        ...child,
        ...(phase === "native"
          ? { PORTCOVE_OUTPUT_DIR: evidence, PORTCOVE_TEMP_DIR: path.join(source, "work", "temp") }
          : {}),
      },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
  } finally {
    await stdout.close();
    await stderr.close();
  }
  clean();
  if (git(source, ["rev-parse", "origin/main"]) !== binding.base)
    throw new Error("Comparison target changed");
  if (phase === "audit") {
    const auditReceipt = await readFile(
      path.join(source, "work", "validation-receipts", "audits", `${binding.source}.json`),
    ).catch((error) => {
      if (errorCode(error) === "ENOENT" && result.status !== 0) return null;
      throw error;
    });
    if (auditReceipt)
      await writeFile(path.join(evidence, "complete-audit-receipt.json"), auditReceipt, {
        flag: "wx",
      });
  }
  await writeFile(
    path.join(evidence, "execution.json"),
    JSON.stringify(
      {
        ...receipt,
        command: [executable, ...args],
        started,
        finished: new Date().toISOString(),
        exit_code: result.status ?? 1,
        error: result.error?.message ?? null,
        tools: { node: process.version, rust: rustPin, just, package_manager: manager },
      },
      null,
      2,
    ) + "\n",
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function cohortInputs(record: {
  workflow?: unknown;
  checkout?: unknown;
  validation?: unknown;
  desired?: unknown;
  observed?: unknown;
  job_toolchains?: unknown;
}) {
  return {
    workflow: record.workflow,
    checkout: record.checkout,
    validation: record.validation,
    desired: record.desired,
    observed: record.observed,
    job_toolchains: record.job_toolchains,
  };
}

function command(commandName: string, args: readonly string[], cwd = root) {
  return execFileSync(commandName, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  }).trim();
}

function rustVersion(value: string, commandName: string): string {
  const match = new RegExp(`^${commandName} (\\d+\\.\\d+\\.\\d+)\\b`, "u").exec(value);
  if (!match) throw new Error(`Unable to parse observed ${commandName} version`);
  const version = match[1];
  if (!version) throw new Error(`Unable to parse observed ${commandName} version`);
  return version;
}

function observedMatch(desired: unknown, observed: unknown) {
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
}: ProvenanceBuildOptions): WorkflowProvenance {
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
  if (typeof validationPlanDigest !== "string" || !/^[a-f0-9]{64}$/u.test(validationPlanDigest))
    throw new Error("validation plan digest must be exact");
  if (
    typeof validationPlanMode !== "string" ||
    !["fast", "prose", "qualification"].includes(validationPlanMode)
  )
    throw new Error("validation plan mode is invalid");
  if (typeof caller !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(caller))
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
  const record: Omit<WorkflowProvenance, "equivalent_cohort"> = {
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

export function parseProvenanceArchive(archive: unknown): unknown {
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
      // Reject duplicates before another decoder can allocate a second bounded payload.
      if (matches.length !== 0) throw new Error("Provenance artifact must contain one JSON record");
      if (flags & 1) throw new Error("Encrypted provenance artifacts are unsupported");
      if (![0, 8].includes(method) || uncompressedSize > 1024 * 1024)
        throw new Error("Unsupported provenance artifact compression");
      if (archive.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error("Malformed provenance artifact ZIP entry");
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
      const contents =
        method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 1024 * 1024 });
      if (contents.length !== uncompressedSize)
        throw new Error("Provenance artifact size mismatch");
      matches.push(contents);
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (matches.length !== 1) throw new Error("Provenance artifact must contain one JSON record");
  const contents = matches[0];
  if (!contents) throw new Error("Provenance artifact must contain one JSON record");
  return JSON.parse(contents.toString("utf8"));
}

export function validateWorkflowProvenance(
  input: unknown,
  {
    runId,
    attempt,
    headSha,
    repository,
    workflow,
    calledWorkflow = workflow,
    event,
  }: ProvenanceValidationContext,
): WorkflowProvenance {
  const record = isRecord(input) ? input : undefined;
  const object = (value: unknown) => (isRecord(value) ? value : undefined);
  const run = object(record?.run);
  const workflowRecord = object(record?.workflow);
  const checkout = object(record?.checkout);
  const validation = object(record?.validation);
  const desired = object(record?.desired);
  const observed = object(record?.observed);
  const runner = object(observed?.runner);
  const expectedPath = `.github/workflows/${workflow}`;
  const expectedCalledPath = `.github/workflows/${calledWorkflow}`;
  const expectedRefPrefix = `${repository}/${expectedPath}@`;
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
  const nonemptyText = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0;
  const hash = (value: unknown): value is string =>
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (
    record?.format_version !== 4 ||
    run?.id !== runId ||
    run?.attempt !== attempt ||
    run?.event !== event ||
    workflowRecord?.caller_path !== expectedPath ||
    typeof workflowRecord.caller_ref !== "string" ||
    !workflowRecord.caller_ref.startsWith(expectedRefPrefix) ||
    workflowRecord.called_path !== expectedCalledPath ||
    workflowRecord.called_source_sha !== checkout?.sha ||
    checkout?.head_sha !== headSha ||
    !exactSha(checkout.sha) ||
    checkout.github_sha !== checkout.sha ||
    !hash(validation?.plan_digest) ||
    typeof validation.mode !== "string" ||
    !["fast", "prose", "qualification"].includes(validation.mode) ||
    typeof validation.caller !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(validation.caller) ||
    !exactSha(workflowRecord.source_sha) ||
    !hash(workflowRecord.content_sha256) ||
    typeof desired?.mode !== "string" ||
    !["ci", "release"].includes(desired.mode) ||
    !nonemptyText(desired.runner) ||
    ![desired.node, desired.package_manager, desired.rust].every(nonemptyText) ||
    ![observed?.node, observed?.package_manager, observed?.rust, observed?.cargo].every(
      (value) => value === null || nonemptyText(value),
    ) ||
    !nonemptyText(runner?.os) ||
    !nonemptyText(runner.architecture) ||
    !Array.isArray(record.job_toolchains) ||
    record.job_toolchains.length === 0 ||
    record.job_toolchains.some((value: unknown) => {
      const job = object(value);
      const jobRunner = object(job?.runner);
      return (
        !nonemptyText(job?.job) ||
        typeof jobRunner?.os !== "string" ||
        typeof jobRunner.architecture !== "string" ||
        ![job.node, job.package_manager, job.rust, job.cargo].some(nonemptyText)
      );
    }) ||
    JSON.stringify(record.matches) !== JSON.stringify(expectedMatches) ||
    Object.values(expectedMatches).some((matches) => matches === false) ||
    record.equivalent_cohort !== expectedCohort
  )
    throw new Error("Provenance artifact identity or configuration mismatch");
  // Return the original record, including retained extra observations, only after validating the contract above.
  return input as WorkflowProvenance;
}

async function main(args = process.argv.slice(2)) {
  if (args[0] === "hosted-validation") {
    if (args.length !== 2) throw new Error("hosted-validation accepts one fixed phase only");
    process.exitCode = await runHostedValidation(args[1]);
    return;
  }
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
    !values.mode ||
    !["ci", "release"].includes(values.mode) ||
    !values.runner ||
    !values.output
  )
    throw new Error(
      "Usage: workflow-provenance --workflow FILE --mode ci|release --runner LABEL --output FILE",
    );
  const node = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const repositoryPackageManager = parsedPackageManager(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
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
      package_manager: repositoryPackageManager.replace(/^pnpm@/u, ""),
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
  void main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
