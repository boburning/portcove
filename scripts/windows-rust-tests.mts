import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCiMetrics } from "./ci-metrics.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import {
  readRustTestImpactMap,
  runnableWorkspaceImpactTests,
  selectWorkspaceRustImpact,
} from "./rust-test-impact.mts";
import { readValidationPlanInput, validateValidationPlan } from "./validation-plan.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const packetDirectory = path.join(root, "work", "windows-rust-tests");
const nextestProfile = "hosted-windows";
const maxMetadataBytes = 32 * 1024 * 1024;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const ordered = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

interface TimingHints {
  format_version: 1;
  default_seconds: number;
  families: [string, string, number][];
  tests: [string, string, number][];
}
export interface WindowsRustPartition {
  id: number;
  estimated_seconds: number;
  tests: string[];
}
interface ArchiveIdentity {
  source: string;
  run: string;
  attempt: string;
  plan: string;
  compiler: string;
  nextest: string;
  target: string;
  inputs: string;
}
export interface WindowsRustManifest {
  format_version: 1;
  identity: ArchiveIdentity;
  archive_sha256: string;
  complete: string[];
  selected: string[];
  partitions: WindowsRustPartition[];
}

function testIdentity(value: unknown): [string, string, string] {
  if (typeof value !== "string") throw new Error("Invalid Rust test identity");
  const parts: unknown = JSON.parse(value);
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    !parts.every((part) => typeof part === "string" && part.length > 0 && part.length < 4096) ||
    JSON.stringify(parts) !== value
  )
    throw new Error("Invalid Rust test identity");
  return parts as [string, string, string];
}

function identities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100000)
    throw new Error("Rust test identities must be nonempty and bounded");
  const result = value.map((entry) => {
    testIdentity(entry);
    return String(entry);
  });
  if (new Set(result).size !== result.length) throw new Error("Duplicate Rust test identity");
  return result;
}

export function validateRustTimingHints(value: unknown): TimingHints {
  const positive = (number: unknown) =>
    typeof number === "number" && Number.isFinite(number) && number > 0 && number < 3600;
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !positive(value.default_seconds) ||
    ![value.families, value.tests].every(
      (rows) =>
        Array.isArray(rows) &&
        rows.length < 10000 &&
        rows.every(
          (row: unknown) =>
            Array.isArray(row) &&
            row.length === 3 &&
            typeof row[0] === "string" &&
            typeof row[1] === "string" &&
            positive(row[2]),
        ),
    )
  )
    throw new Error("Invalid bounded Rust scheduling hints");
  return value as unknown as TimingHints;
}

/** Hints affect scheduling only; every current selected identity is assigned exactly once. */
export function partitionWindowsRustTests(
  selected: string[],
  hints: TimingHints,
  maximumWorkers = 8,
) {
  const tests = identities(selected);
  validateRustTimingHints(hints);
  if (!Number.isInteger(maximumWorkers) || maximumWorkers < 1 || maximumWorkers > 8)
    throw new Error("Windows Rust workers must be between one and eight");
  const exact = new Map(
    hints.tests.map(([binary, name, seconds]) => [JSON.stringify([binary, name]), seconds]),
  );
  const weighted = tests.map((identity) => {
    const [, binary, name] = testIdentity(identity);
    const family = hints.families
      .filter(([candidate, prefix]) => candidate === binary && name.startsWith(prefix))
      .sort((left, right) => right[1].length - left[1].length)[0];
    return {
      identity,
      seconds: exact.get(JSON.stringify([binary, name])) ?? family?.[2] ?? hints.default_seconds,
    };
  });
  // Avoid eight runner startups for a small focused change. Broad suites use all eight.
  const count = Math.min(
    maximumWorkers,
    tests.length,
    Math.max(1, Math.ceil(weighted.reduce((total, test) => total + test.seconds, 0) / 180)),
  );
  const partitions: WindowsRustPartition[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    estimated_seconds: 0,
    tests: [],
  }));
  for (const test of weighted.sort(
    (left, right) => right.seconds - left.seconds || ordered(left.identity, right.identity),
  )) {
    const partition = [...partitions].sort(
      (left, right) => left.estimated_seconds - right.estimated_seconds || left.id - right.id,
    )[0];
    if (!partition) throw new Error("Missing Windows Rust partition");
    partition.tests.push(test.identity);
    partition.estimated_seconds += test.seconds;
  }
  return partitions.map((partition) => ({
    ...partition,
    estimated_seconds: Math.round(partition.estimated_seconds * 1000) / 1000,
    tests: partition.tests.sort(ordered),
  }));
}

function assertSameIdentities(actual: Set<string>, expected: readonly string[], label: string) {
  if (actual.size !== expected.length || expected.some((test) => !actual.has(test)))
    throw new Error(`${label} differs from its complete expected inventory`);
}

export function validateWindowsRustManifest(value: unknown, identity: ArchiveIdentity) {
  const observedIdentity: Record<string, unknown> =
    isRecord(value) && isRecord(value.identity) ? value.identity : {};
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !isRecord(value.identity) ||
    Object.keys(value.identity).length !== Object.keys(identity).length ||
    Object.entries(identity).some(([key, expected]) => observedIdentity[key] !== expected) ||
    typeof value.archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.archive_sha256) ||
    !Array.isArray(value.partitions) ||
    value.partitions.length === 0 ||
    value.partitions.length > 8
  )
    throw new Error("Windows Rust archive identity or partition manifest mismatch");
  const complete = new Set(identities(value.complete));
  const selected = identities(value.selected);
  if (selected.some((test) => !complete.has(test)))
    throw new Error("Selected Rust tests escaped the complete workspace inventory");
  const union = new Set<string>();
  for (const [index, partition] of value.partitions.entries()) {
    if (
      !isRecord(partition) ||
      partition.id !== index + 1 ||
      typeof partition.estimated_seconds !== "number" ||
      !Number.isFinite(partition.estimated_seconds) ||
      partition.estimated_seconds <= 0
    )
      throw new Error("Invalid Windows Rust partition");
    for (const test of identities(partition.tests)) {
      if (union.has(test)) throw new Error("Windows Rust partitions overlap");
      union.add(test);
    }
  }
  assertSameIdentities(union, selected, "Windows Rust partition union");
  return value as unknown as WindowsRustManifest;
}

export function windowsPartitionConfig(config: string, tests: string[]) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  const binaries = new Map<string, string[]>();
  for (const identity of identities(tests)) {
    const [, binary, name] = testIdentity(identity);
    const names = binaries.get(binary) ?? [];
    names.push(escape(name));
    binaries.set(binary, names);
  }
  const filter = [...binaries]
    .sort(([left], [right]) => ordered(left, right))
    .map(
      ([binary, names]) =>
        `(binary_id(/^${escape(binary)}$/) & test(/^(?:${names.sort(ordered).join("|")})$/))`,
    )
    .join(" | ");
  const header = `[profile.${nextestProfile}]`;
  if (config.split(header).length !== 2 || /default-filter\s*=/u.test(config))
    throw new Error("Expected one hosted Windows profile and no existing default filter");
  // A config file avoids Windows' command-line length limit. All original overrides survive.
  return config.replace(header, `${header}\ndefault-filter = ${JSON.stringify(filter)}`);
}

function execute(command: string, args: string[], capture = true) {
  const result = spawnSync(command, args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: maxMetadataBytes,
    ...(capture ? {} : { stdio: "inherit" as const }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} ${args[0]} failed with status ${result.status}`);
  }
  return result.stdout ?? "";
}

function readJson(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxMetadataBytes)
    throw new Error("Invalid or oversized Windows Rust metadata file");
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function fileDigest(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
    throw new Error("Windows Rust archive must be a nonempty regular file");
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes: number;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function currentContext() {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Windows test transfer is a hosted Windows entrypoint");
  const plan = validateValidationPlan(readValidationPlanInput());
  const source = execute("git", ["rev-parse", "HEAD"]).trim();
  if (source !== plan.identities.checkout || plan.mode !== "fast" || !plan.groups.includes("rust"))
    throw new Error("Windows Rust transfer plan/source mismatch");
  const run = process.env.GITHUB_RUN_ID ?? "";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  if (!/^[1-9][0-9]*$/u.test(run) || !/^[1-9][0-9]*$/u.test(attempt))
    throw new Error("Windows Rust transfer requires current run and attempt identities");
  const compiler = execute("rustc", ["--version", "--verbose"]).trim();
  const nextest = execute("cargo-nextest", ["nextest", "--version"]).trim();
  if (!compiler.includes("\nhost: x86_64-pc-windows-msvc\n"))
    throw new Error("Windows test archive requires the native x64 MSVC compiler");
  const manifests = execute("git", ["ls-files", "-z", "--", "Cargo.toml", "**/Cargo.toml"])
    .split("\0")
    .filter(Boolean);
  const inputs = digest(
    JSON.stringify(
      [
        ...manifests,
        "Cargo.lock",
        "rust-toolchain.toml",
        ".config/nextest.toml",
        ".config/rust-test-impact.json",
        ".github/quality-tools.json",
      ]
        .sort(ordered)
        .map((file) => [file, digest(readFileSync(path.join(root, file)))]),
    ),
  );
  return {
    plan,
    identity: {
      source,
      run,
      attempt,
      plan: plan.digest,
      compiler,
      nextest,
      target: "x86_64-pc-windows-msvc",
      inputs,
    },
  };
}

function listTests(args: string[], allowSkipped = true) {
  return runnableWorkspaceImpactTests(
    JSON.parse(execute("cargo-nextest", ["nextest", "list", ...args, "--message-format", "json"])),
    { allowSkipped },
  );
}

export function buildWindowsRustArchive() {
  const { plan, identity } = currentContext();
  const metrics = createCiMetrics();
  mkdirSync(packetDirectory, { recursive: true });
  const binaries = path.join(packetDirectory, "binaries.json");
  const cargo = path.join(packetDirectory, "cargo.json");
  const scope = ["--locked", "--workspace", "--all-targets"];
  metrics.measure("windows-workspace-build", () => {
    writeFileSync(
      binaries,
      execute("cargo-nextest", [
        "nextest",
        "list",
        ...scope,
        "--list-type",
        "binaries-only",
        "--message-format",
        "json",
      ]),
      { flag: "wx" },
    );
    writeFileSync(cargo, execute("cargo", ["metadata", "--locked", "--format-version", "1"]), {
      flag: "wx",
    });
  });
  const metadata = [
    "--binaries-metadata",
    binaries,
    "--cargo-metadata",
    cargo,
    "--profile",
    nextestProfile,
  ];
  const snapshots = [binaries, cargo].map((file) => ({ file, bytes: readFileSync(file) }));
  const verifyMetadata = () => {
    for (const { file, bytes } of snapshots) {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== bytes.length ||
        !readFileSync(file).equals(bytes)
      )
        throw new Error("Windows Rust inventory metadata changed during preparation");
    }
  };
  const inventory = (args: string[], allowSkipped = true) => {
    verifyMetadata();
    const tests = listTests(args, allowSkipped);
    verifyMetadata();
    return tests;
  };
  const complete = inventory([...metadata, "-E", "all()"], false);
  if (!complete.size) throw new Error("Windows workspace inventory is empty");
  let map;
  try {
    map = readRustTestImpactMap();
  } catch {
    map = null;
  }
  const groups = selectWorkspaceRustImpact(plan, map);
  const selected = new Set<string>();
  for (const group of groups) {
    const matches =
      group.filter === "all()" ? complete : inventory([...metadata, "-E", group.filter]);
    if (!matches.size) throw new Error(`Rust impact group ${group.id} has no runnable tests`);
    for (const test of matches) {
      if (!complete.has(test) || (group.packageName && testIdentity(test)[0] !== group.packageName))
        throw new Error("Rust impact group escaped the complete workspace/package inventory");
      selected.add(test);
    }
    console.log(`[rust-impact] ${group.id}: ${matches.size} runnable tests; ${group.reason}`);
  }
  const unionFilter = groups.map((group) => `(${group.filter})`).join(" | ");
  const union = inventory([...metadata, "-E", unionFilter]);
  assertSameIdentities(union, [...selected], "Rust impact union");
  const hints = validateRustTimingHints(
    readJson(path.join(root, ".config/rust-test-timing-hints.json")),
  );
  const partitions = partitionWindowsRustTests([...selected], hints);
  const config = readFileSync(path.join(root, ".config/nextest.toml"), "utf8");
  for (const partition of partitions) {
    const file = path.join(packetDirectory, `partition-${partition.id}.toml`);
    writeFileSync(file, windowsPartitionConfig(config, partition.tests), { flag: "wx" });
    assertSameIdentities(
      inventory([...metadata, "--config-file", file]),
      partition.tests,
      `Partition ${partition.id}`,
    );
  }
  const archive = path.join(packetDirectory, "tests.tar.zst");
  metrics.measure("windows-test-archive", () =>
    execute("cargo-nextest", ["nextest", "archive", ...scope, "--archive-file", archive], false),
  );
  verifyMetadata();
  const manifest: WindowsRustManifest = {
    format_version: 1,
    identity,
    archive_sha256: fileDigest(archive),
    complete: [...complete].sort(ordered),
    selected: [...selected].sort(ordered),
    partitions,
  };
  validateWindowsRustManifest(manifest, identity);
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(path.join(packetDirectory, "manifest.json"), manifestBytes, { flag: "wx" });
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing Windows Rust producer output channel");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify(partitions.map(({ id }) => ({ partition: id })))}\nmanifest_sha256=${digest(manifestBytes)}\n`,
  );
  metrics.record("rust-selection", {
    complete_tests: complete.size,
    selected_tests: selected.size,
    groups: groups.map((group) => group.id),
  });
  console.log(
    `[rust-impact] ${selected.size}/${complete.size} tests; ${partitions.length} disjoint workers`,
  );
  for (const partition of partitions)
    console.log(
      `[rust-partition] ${partition.id}: ${partition.tests.length} tests, ${partition.estimated_seconds}s historical summed-work estimate`,
    );
}

export function runWindowsRustPartition(partitionId: number) {
  const { identity } = currentContext();
  const metrics = createCiMetrics();
  const manifestFile = path.join(packetDirectory, "manifest.json");
  if (fileDigest(manifestFile) !== process.env.PORTCOVE_WINDOWS_MANIFEST_SHA256)
    throw new Error("Windows Rust manifest differs from this producer's output");
  const manifest = validateWindowsRustManifest(readJson(manifestFile), identity);
  const partition = manifest.partitions.find(({ id }) => id === partitionId);
  if (!partition) throw new Error("Unknown Windows Rust execution partition");
  const archive = path.join(packetDirectory, "tests.tar.zst");
  if (fileDigest(archive) !== manifest.archive_sha256)
    throw new Error("Windows Rust archive digest mismatch");
  const extracted = path.join(root, "work", "windows-rust-extracted");
  mkdirSync(extracted, { recursive: true });
  const complete = metrics.measure("windows-test-extract-and-inventory", () =>
    listTests(
      [
        "--archive-file",
        archive,
        "--extract-to",
        extracted,
        "--workspace-remap",
        root,
        "--profile",
        nextestProfile,
        "-E",
        "all()",
      ],
      false,
    ),
  );
  assertSameIdentities(complete, manifest.complete, "Transferred workspace");
  const target = path.join(extracted, "target");
  const metadata = [
    "--binaries-metadata",
    path.join(target, "nextest", "binaries-metadata.json"),
    "--cargo-metadata",
    path.join(target, "nextest", "cargo-metadata.json"),
    "--target-dir-remap",
    target,
    "--workspace-remap",
    root,
  ];
  const config = path.join(packetDirectory, `execute-${partition.id}.toml`);
  writeFileSync(
    config,
    windowsPartitionConfig(
      readFileSync(path.join(root, ".config/nextest.toml"), "utf8"),
      partition.tests,
    ),
    { flag: "wx" },
  );
  const args = [...metadata, "--profile", nextestProfile, "--config-file", config];
  assertSameIdentities(listTests(args), partition.tests, "Transferred partition");
  metrics.measure("selected-rust-tests", () =>
    execute("cargo-nextest", ["nextest", "run", ...args], false),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { resourceEntrypoint } = await import("./resource-command.mts");
    process.exitCode = await resourceEntrypoint("rust", async () => {
      if (process.argv[2] === "build" && process.argv.length === 3) buildWindowsRustArchive();
      else if (
        process.argv[2] === "run" &&
        /^[1-8]$/u.test(process.argv[3] ?? "") &&
        process.argv.length === 4
      )
        runWindowsRustPartition(Number(process.argv[3]));
      else throw new Error("Use windows-rust-tests.mts build or run <partition>");
      return 0;
    });
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
