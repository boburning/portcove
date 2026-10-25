import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedCoverageRead } from "./test-coverage-config.mts";
import { runResourceCommand } from "./resource-command.mts";
import { frontendOutputResource } from "./resource-capacity.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { validateQualityManifest } from "./quality-tools.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const maximumReport = 128 * 1024 * 1024;
const readJson = (file: string): unknown =>
  JSON.parse(boundedCoverageRead(file, 4 * 1024 * 1024).toString("utf8"));

export interface RustCoveragePins {
  format_version: 1;
  toolchain: string;
  compiler_release: string;
  compiler_commit: string;
  llvm_version: string;
  target: "x86_64-pc-windows-msvc";
  package: "portcove-core";
  test_filter: "path::";
  module: "crates/portcove-core/src/path.rs";
}

export function rustCoverageBuildPrefix(supervisorTarget: string) {
  if (!path.win32.isAbsolute(supervisorTarget))
    throw new Error("Rust coverage requires an absolute ordinary Cargo target");
  const prefix = path.win32.join(supervisorTarget, "rcov-");
  if ((prefix + "XXXXXX").length > 64)
    throw new Error(
      "Rust coverage requires a short existing CARGO_TARGET_DIR for the Windows linker",
    );
  return prefix;
}

export function validateRustCoveragePins(value: unknown): RustCoveragePins {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    typeof value.toolchain !== "string" ||
    !/^nightly-\d{4}-\d{2}-\d{2}$/u.test(value.toolchain) ||
    typeof value.compiler_release !== "string" ||
    !/^\d+\.\d+\.\d+-nightly$/u.test(value.compiler_release) ||
    typeof value.compiler_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.compiler_commit) ||
    typeof value.llvm_version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(value.llvm_version) ||
    value.target !== "x86_64-pc-windows-msvc" ||
    value.package !== "portcove-core" ||
    value.test_filter !== "path::" ||
    value.module !== "crates/portcove-core/src/path.rs"
  )
    throw new Error("Invalid bounded Rust coverage investigation");
  return value as unknown as RustCoveragePins;
}

export function rustCoverageCommands(pins: RustCoveragePins, directory: string) {
  validateRustCoveragePins(pins);
  const prefix = ["run", pins.toolchain, "cargo", "llvm-cov"];
  const tests = [
    "test",
    "--branch",
    "--locked",
    "--offline",
    "--package",
    pins.package,
    "--lib",
    "--target",
    pins.target,
    "--no-cfg-coverage",
    "--no-cfg-coverage-nightly",
    "--no-report",
  ];
  return [
    {
      name: "discovery",
      timeout_ms: 30 * 60000,
      args: [...prefix, ...tests, pins.test_filter, "--", "--list"],
    },
    {
      name: "tests",
      timeout_ms: 5 * 60000,
      args: [
        ...prefix,
        ...tests,
        pins.test_filter,
        "--",
        "--test-threads=2",
        "--format=json",
        "-Z",
        "unstable-options",
      ],
    },
    {
      name: "report",
      timeout_ms: 5 * 60000,
      args: [
        ...prefix,
        "report",
        "--locked",
        "--offline",
        "--package",
        pins.package,
        "--target",
        pins.target,
        "--json",
        "--output-path",
        path.join(directory, "coverage.json"),
      ],
    },
  ];
}

export function rustCoverageDiscovery(raw: string, prefix: string) {
  const tests: string[] = [];
  let declared: number | null = null;
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    const test = /^(.*): test$/u.exec(line);
    if (test) {
      if (!test[1]!.startsWith(prefix) || tests.includes(test[1]!) || test[1]!.length > 4096)
        throw new Error("Unexpected or duplicate Rust coverage discovery case");
      tests.push(test[1]!);
    } else {
      const summary = /^(\d+) tests?, 0 benchmarks?$/u.exec(line);
      if (!summary || declared !== null)
        throw new Error("Malformed Rust coverage discovery output");
      declared = Number(summary[1]);
    }
  }
  if (!tests.length || tests.length > 1000 || declared !== tests.length)
    throw new Error("Empty or incomplete Rust coverage discovery");
  return tests.sort();
}

export function rustCoverageOutcomes(raw: string, selected: readonly string[]) {
  const terminal = new Map<string, { name: string; outcome: string; seconds: number | null }>();
  let started = false,
    ended = false;
  for (const line of raw.split(/\r?\n/u).filter(Boolean)) {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event)) throw new Error("Malformed Rust coverage test event");
    if (event.type === "suite") {
      if (event.event === "started" && !started && event.test_count === selected.length)
        started = true;
      else if (
        (event.event === "ok" || event.event === "failed") &&
        started &&
        !ended &&
        [event.passed, event.failed, event.ignored].every(
          (count) => Number.isSafeInteger(count) && Number(count) >= 0,
        ) &&
        Number(event.passed) + Number(event.failed) + Number(event.ignored) === selected.length &&
        event.event === (Number(event.failed) === 0 ? "ok" : "failed") &&
        Number(event.passed) ===
          [...terminal.values()].filter((row) => row.outcome === "ok").length &&
        Number(event.failed) ===
          [...terminal.values()].filter((row) => row.outcome === "failed").length &&
        Number(event.ignored) ===
          [...terminal.values()].filter((row) => row.outcome === "ignored").length
      )
        ended = true;
      else throw new Error("Incomplete Rust coverage suite result");
    } else if (
      event.type === "test" &&
      typeof event.name === "string" &&
      selected.includes(event.name) &&
      started &&
      !ended
    ) {
      if (event.event === "started") continue;
      if (!["ok", "failed", "ignored"].includes(String(event.event)) || terminal.has(event.name))
        throw new Error("Unexpected or duplicate Rust coverage outcome");
      terminal.set(event.name, {
        name: event.name,
        outcome: String(event.event),
        seconds:
          typeof event.exec_time === "number" &&
          Number.isFinite(event.exec_time) &&
          event.exec_time >= 0
            ? event.exec_time
            : null,
      });
    } else throw new Error("Unexpected Rust coverage result case");
  }
  if (!ended || terminal.size !== selected.length)
    throw new Error("Missing Rust coverage terminal outcomes");
  return [...terminal.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function rustBranchCoverage(value: unknown, filename: string) {
  const normalized = (file: string) => path.resolve(file).toLowerCase();
  if (!isRecord(value) || value.type !== "llvm.coverage.json.export" || !Array.isArray(value.data))
    throw new Error("Invalid LLVM coverage export");
  const files = value.data.flatMap((entry: unknown) =>
    isRecord(entry) && Array.isArray(entry.files) ? (entry.files as unknown[]) : [],
  );
  const matches = files.filter(
    (file: unknown) =>
      isRecord(file) &&
      typeof file.filename === "string" &&
      normalized(file.filename) === normalized(filename),
  );
  if (matches.length !== 1 || !isRecord(matches[0]))
    throw new Error("Missing or duplicate measured Rust source file");
  const file = matches[0];
  if (
    !isRecord(file.summary) ||
    !Array.isArray(file.branches) ||
    !file.branches.length ||
    !file.branches.every(
      (row: unknown) =>
        Array.isArray(row) &&
        row.length >= 6 &&
        row
          .slice(0, 6)
          .every((number: unknown) => Number.isSafeInteger(number) && Number(number) >= 0),
    )
  )
    throw new Error("Missing measured Rust branch counters");
  for (const key of ["branches", "lines", "functions", "regions"]) {
    const summary = file.summary[key];
    if (
      !isRecord(summary) ||
      !Number.isSafeInteger(summary.count) ||
      Number(summary.count) < 0 ||
      !Number.isSafeInteger(summary.covered) ||
      Number(summary.covered) < 0 ||
      Number(summary.covered) > Number(summary.count)
    )
      throw new Error("Invalid measured Rust coverage summary");
  }
  if (Number((file.summary.branches as Record<string, unknown>).count) === 0)
    throw new Error("Rust branch instrumentation produced no branches");
  return { filename: file.filename, summary: file.summary, branches: file.branches };
}

function probe(command: string, args: string[], environment = process.env) {
  return execFileSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function gitSource() {
  const head = probe("git", ["rev-parse", "HEAD"]),
    tree = probe("git", ["rev-parse", "HEAD^{tree}"]);
  if (probe("git", ["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Rust coverage requires a clean, committed source checkout");
  return { head, tree };
}

function runtime(pins: RustCoveragePins) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("This opt-in Rust coverage preset is qualified only for native Windows x64");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RUSTUP_AUTO_INSTALL: "0",
    RUSTUP_TOOLCHAIN: pins.toolchain,
  };
  for (const key of Object.keys(environment))
    if (
      /^(?:RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|RUSTC|RUSTDOC|LLVM_|CARGO_LLVM_COV_)/u.test(
        key,
      ) ||
      /^CARGO_(?:BUILD|TARGET_.*)_RUSTFLAGS$/u.test(key)
    )
      delete environment[key];
  const compiler = probe(
    "rustup",
    ["run", pins.toolchain, "rustc", "--version", "--verbose"],
    environment,
  );
  for (const expected of [
    `release: ${pins.compiler_release}`,
    `commit-hash: ${pins.compiler_commit}`,
    `host: ${pins.target}`,
    `LLVM version: ${pins.llvm_version}`,
  ])
    if (!compiler.split(/\r?\n/u).includes(expected))
      throw new Error("Coverage compiler identity differs from its pin");
  const sysroot = probe(
    "rustup",
    ["run", pins.toolchain, "rustc", "--print", "sysroot"],
    environment,
  );
  const llvm = Object.fromEntries(
    ["llvm-cov", "llvm-profdata"].map((name) => {
      const file = path.join(sysroot, "lib", "rustlib", pins.target, "bin", name + ".exe");
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        path.resolve(realpathSync(file)) !== path.resolve(file)
      )
        throw new Error("Matching llvm-tools-preview component is unavailable");
      const version = probe(file, ["--version"], environment);
      if (!version.includes(`LLVM version ${pins.llvm_version}`))
        throw new Error("Coverage LLVM tools differ from the compiler");
      return [name, { file, version }];
    }),
  );
  const manifest = readJson(path.join(root, ".github/quality-tools.json"));
  validateQualityManifest(manifest);
  const tool = manifest.tools.find(({ id }) => id === "cargo-llvm-cov");
  if (!tool || tool.tier !== "deep" || tool.ci_install !== "local")
    throw new Error("Missing opt-in coverage tool pin");
  const toolVersion = probe(
    "rustup",
    ["run", pins.toolchain, "cargo", "llvm-cov", "--version"],
    environment,
  );
  if (toolVersion !== `cargo-llvm-cov ${tool.version}`)
    throw new Error("Coverage tool version differs from its pin");
  environment.LLVM_COV = llvm["llvm-cov"]!.file;
  environment.LLVM_PROFDATA = llvm["llvm-profdata"]!.file;
  // The maintained supervisor keeps its normal compiler. Each payload explicitly
  // enters the dated coverage toolchain through `rustup run`.
  environment.RUSTUP_TOOLCHAIN = manifest.rust.channel;
  return {
    environment,
    identity: { compiler, tool: toolVersion, llvm, supervisor_toolchain: manifest.rust.channel },
  };
}

export function publishRustCoverage(
  result: { exit_status: number; complete: boolean; failure: string | null },
  publish: () => void,
  diagnostic: (message: string) => void = console.error,
) {
  try {
    publish();
  } catch (error) {
    result.complete = false;
    result.failure = [result.failure, `Coverage publication failed: ${errorMessage(error)}`]
      .filter(Boolean)
      .join("; ");
    result.exit_status ||= 1;
    try {
      diagnostic(result.failure);
    } catch {
      /* A broken diagnostic stream cannot replace native failure. */
    }
  }
  return result.exit_status;
}

export async function runRustCoverage() {
  const pins = validateRustCoveragePins(readJson(path.join(root, ".config/rust-coverage.json")));
  const source = gitSource(),
    inspected = runtime(pins);
  const parent = path.join(root, "work/rust-coverage");
  mkdirSync(parent, { recursive: true });
  const relative = path.relative(realpathSync(root), realpathSync(parent));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Coverage output resolves outside the checkout");
  const directory = path.join(parent, randomUUID());
  mkdirSync(directory);
  const physical = lstatSync(directory, { bigint: true });
  const supervisorTarget = path.resolve(root, inspected.environment.CARGO_TARGET_DIR ?? "target");
  const buildDirectory = mkdtempSync(rustCoverageBuildPrefix(supervisorTarget));
  const buildPhysical = lstatSync(buildDirectory, { bigint: true });
  const verify = () => {
    for (const [location, identity] of [
      [directory, physical],
      [buildDirectory, buildPhysical],
    ] as const) {
      const stat = lstatSync(location, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        path.resolve(realpathSync(location)) !== path.resolve(location)
      )
        throw new Error("Rust coverage packet or instrumented build was redirected");
    }
    if (JSON.stringify(gitSource()) !== JSON.stringify(source))
      throw new Error("Rust coverage source changed");
  };
  const inputFiles = [
    pins.module,
    "crates/portcove-core/src/path_property_tests.rs",
    "crates/portcove-core/Cargo.toml",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    ".config/rust-coverage.json",
    ".github/quality-tools.json",
    "scripts/rust-coverage.mts",
    "scripts/test-coverage-config.mts",
  ];
  const inputs = inputFiles.map((file) => {
    const bytes = boundedCoverageRead(path.join(root, file), 16 * 1024 * 1024);
    const copy = path.join(directory, "source", file);
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, bytes, { flag: "wx" });
    return { file, sha256: hash(bytes) };
  });
  const commands = rustCoverageCommands(pins, directory);
  const request = {
    format_version: 1,
    source,
    inputs,
    pins,
    runtime: inspected.identity,
    platform: process.platform,
    arch: process.arch,
    commands,
    directories: {
      instrumented_build: buildDirectory,
      supervisor_target: supervisorTarget,
    },
    feature_selection: "Core default package features; no feature overrides",
    instrumentation: "nightly branch coverage; cfg(coverage) and cfg(coverage_nightly) disabled",
  };
  writeFileSync(path.join(directory, "request.json"), JSON.stringify(request, null, 2) + "\n", {
    flag: "wx",
  });
  const receipt = openSync(path.join(directory, "receipt.json"), "wx");
  const environment = {
    ...inspected.environment,
    CARGO_LLVM_COV_TARGET_DIR: buildDirectory,
    CARGO_BUILD_JOBS: "2",
    CARGO_INCREMENTAL: "0",
  };
  const stages: { name: string; status: number; elapsed_ms: number }[] = [];
  let selected: string[] = [],
    outcomes: ReturnType<typeof rustCoverageOutcomes> = [],
    coverage: unknown = null;
  let originalStatus = 0,
    failure: string | null = null;
  try {
    for (const command of commands) {
      verify();
      const out = openSync(path.join(directory, command.name + ".stdout.log"), "wx");
      const err = openSync(path.join(directory, command.name + ".stderr.log"), "wx");
      const started = performance.now();
      let status: number;
      try {
        status = await runResourceCommand("rust", "rustup", command.args, {
          cwd: root,
          environment,
          output: { stdout: out, stderr: err },
          executionTimeoutMilliseconds: command.timeout_ms,
          queueDeadline: performance.now() + 15 * 60000,
          exclusive: [frontendOutputResource(environment.CARGO_LLVM_COV_TARGET_DIR)],
        });
        if (status !== 0 && originalStatus === 0) originalStatus = status;
      } finally {
        closeSync(out);
        closeSync(err);
      }
      stages.push({
        name: command.name,
        status,
        elapsed_ms: Math.round(performance.now() - started),
      });
      verify();
      const stdout = boundedCoverageRead(
        path.join(directory, command.name + ".stdout.log"),
        maximumReport,
      ).toString("utf8");
      if (command.name === "discovery") {
        if (status !== 0) throw new Error("Rust coverage discovery failed");
        selected = rustCoverageDiscovery(stdout, pins.test_filter);
      } else if (command.name === "tests") {
        outcomes = rustCoverageOutcomes(stdout, selected);
        if (status === 0 && outcomes.some(({ outcome }) => outcome !== "ok"))
          throw new Error("Native success contradicted Rust coverage outcomes");
      } else {
        if (status !== 0) throw new Error("LLVM coverage export failed");
        const bytes = boundedCoverageRead(path.join(directory, "coverage.json"), maximumReport);
        coverage = {
          report_sha256: hash(bytes),
          module: rustBranchCoverage(
            JSON.parse(bytes.toString("utf8")),
            path.join(root, pins.module),
          ),
        };
      }
    }
    verify();
    for (const { file, sha256 } of inputs)
      if (hash(boundedCoverageRead(path.join(root, file), 16 * 1024 * 1024)) !== sha256)
        throw new Error("Coverage source input changed");
  } catch (error) {
    failure = errorMessage(error);
  }
  const result = {
    ...request,
    stages,
    selected,
    outcomes,
    coverage,
    failure,
    complete: originalStatus === 0 && failure === null && coverage !== null,
    exit_status: originalStatus || (failure === null && coverage !== null ? 0 : 1),
    limits:
      "Windows Core path module investigation only, including embedded test code; no complete path, package, Desktop, native-operation or performance qualification. Stage elapsed time includes admission and setup.",
  };
  return publishRustCoverage(result, () => {
    try {
      if (!fstatSync(receipt).isFile()) throw new Error("Coverage receipt descriptor changed");
      writeFileSync(receipt, JSON.stringify(result, null, 2) + "\n");
    } finally {
      closeSync(receipt);
    }
    console.log(
      JSON.stringify({ directory, status: result.exit_status, complete: result.complete, failure }),
    );
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2)
      throw new Error("Use rust-coverage.mts with its fixed opt-in preset");
    process.exitCode = await runRustCoverage();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
