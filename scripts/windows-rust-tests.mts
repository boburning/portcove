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
import {
  nextestSkipRouteInventory,
  readNextestSkipRoutes,
  type NextestSkipRoute,
} from "./nextest-skip-routes.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import {
  nextestOutcomeSelection,
  runNextestWithOutcomes,
  runnableNextestTests,
} from "./nextest-outcomes.mts";
import { readRustTestImpactMap, selectWorkspaceRustImpact } from "./rust-test-impact.mts";
import { readValidationPlanInput, validateValidationPlan } from "./validation-plan.mts";
import {
  qualificationCoreScope,
  qualificationCoreProfile,
  qualificationCoreWorkers,
  reusedQualificationArguments,
  nextestListArguments,
  type QualificationCoreWorkerInventory,
} from "./windows-qualification-rust.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const packetDirectory = path.join(root, "work", "windows-rust-tests");
export const windowsRustSkipResultsDirectory = path.join(
  root,
  "work",
  "test-results",
  "windows-rust-skip-routes",
);
const nextestProfile = "hosted-windows";
const maxMetadataBytes = 32 * 1024 * 1024;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const ordered = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function writeWindowsRustSkipRoutes(
  directory: string,
  inventory: unknown,
  identity: ArchiveIdentity,
  {
    coreOnly = false,
    routes = readNextestSkipRoutes(),
  }: { coreOnly?: boolean; routes?: readonly NextestSkipRoute[] } = {},
) {
  mkdirSync(directory, { recursive: true });
  const report = nextestSkipRouteInventory(
    inventory,
    coreOnly ? routes.filter((route) => route.package === "portcove-core") : routes,
    { platform: "win32" },
  );
  const complete = JSON.stringify(inventory) + "\n";
  writeFileSync(path.join(directory, "skip-routes.inventory.json"), complete, { flag: "wx" });
  const bytes =
    JSON.stringify(
      {
        format_version: 1,
        identity,
        complete_inventory_sha256: digest(complete),
        ...report,
      },
      null,
      2,
    ) + "\n";
  writeFileSync(path.join(directory, "skip-routes.json"), bytes, { flag: "wx" });
  writeFileSync(path.join(directory, "skip-routes.sha256"), digest(bytes) + "\n", { flag: "wx" });
  return report.errors;
}

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

export interface WindowsQualificationCoreManifest {
  format_version: 2;
  identity: ArchiveIdentity;
  profile: "default";
  scope: string[];
  archive_sha256: string;
  complete: string[];
  workers: QualificationCoreWorkerInventory[];
  binaries_sha256: string;
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

export function validateWindowsQualificationCoreManifest(
  value: unknown,
  identity: ArchiveIdentity,
) {
  const observedIdentity: Record<string, unknown> =
    isRecord(value) && isRecord(value.identity) ? value.identity : {};
  if (
    !isRecord(value) ||
    value.format_version !== 2 ||
    !isRecord(value.identity) ||
    Object.keys(value.identity).length !== Object.keys(identity).length ||
    Object.entries(identity).some(([key, expected]) => observedIdentity[key] !== expected) ||
    value.profile !== qualificationCoreProfile ||
    typeof value.binaries_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.binaries_sha256) ||
    JSON.stringify(value.scope) !== JSON.stringify(qualificationCoreScope) ||
    typeof value.archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.archive_sha256) ||
    !Array.isArray(value.workers)
  )
    throw new Error("Qualification Core archive identity, profile or scope mismatch");
  const complete = identities(value.complete);
  if (complete.some((test) => testIdentity(test)[0] !== "portcove-core"))
    throw new Error("Qualification Core archive contains another package");
  const policy = qualificationCoreWorkers();
  if (value.workers.length !== policy.length) throw new Error("Qualification Core workers missing");
  const union = new Set<string>();
  for (const [index, worker] of value.workers.entries()) {
    const expected = policy[index]!;
    if (
      !isRecord(worker) ||
      worker.name !== expected.name ||
      !Array.isArray(worker.phases) ||
      worker.phases.length !== expected.phases.length
    )
      throw new Error("Qualification Core worker phases differ");
    for (const [phaseIndex, phase] of worker.phases.entries()) {
      const expectedPhase = expected.phases[phaseIndex]!;
      if (
        !isRecord(phase) ||
        phase.name !== expectedPhase.name ||
        JSON.stringify(phase.arguments) !== JSON.stringify(expectedPhase.arguments)
      )
        throw new Error("Qualification Core phase arguments or order differ");
      for (const test of identities(phase.tests)) {
        if (!complete.includes(test))
          throw new Error("Qualification Core phase escaped its inventory");
        union.add(test);
      }
    }
  }
  assertSameIdentities(union, complete, "Qualification Core phase union");
  return value as unknown as WindowsQualificationCoreManifest;
}

export function windowsPartitionConfig(config: string, tests: string[], profile = nextestProfile) {
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
  if (![nextestProfile, qualificationCoreProfile].includes(profile))
    throw new Error("Unsupported Windows Rust execution profile");
  const header = `[profile.${profile}]`;
  if (config.split(header).length !== 2 || /default-filter\s*=/u.test(config))
    throw new Error("Expected one Windows execution profile and no existing default filter");
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
  if (
    source !== plan.identities.checkout ||
    !["fast", "qualification"].includes(plan.mode) ||
    !plan.groups.includes("rust")
  )
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
        "scripts/nextest-skip-routes.mts",
        ".github/quality-tools.json",
        ...(plan.mode === "qualification"
          ? [
              "scripts/windows-rust-tests.mts",
              "scripts/windows-qualification-rust.mts",
              "scripts/fixtures/windows-qualification-selection.json",
            ]
          : []),
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

export function runnableWindowsRustTests(inventory: unknown, { allowSkipped = false } = {}) {
  return runnableNextestTests(inventory, { allowSkipped, allowDefaultSkipped: allowSkipped });
}

function listInventory(args: string[]): unknown {
  return JSON.parse(execute("cargo-nextest", ["nextest", "list", ...nextestListArguments(args)]));
}

function listTests(args: string[], allowSkipped = true) {
  return runnableWindowsRustTests(listInventory(args), { allowSkipped });
}

/** Bind every discovered binary, including binaries with only ignored cases. */
export function qualificationBinaryListDigest(inventory: unknown) {
  runnableWindowsRustTests(inventory);
  if (!isRecord(inventory) || !isRecord(inventory["rust-suites"]))
    throw new Error("Missing qualification binary inventory");
  return digest(
    JSON.stringify(
      Object.entries(inventory["rust-suites"])
        .sort(([left], [right]) => ordered(left, right))
        .map(([id, suite]) => {
          if (
            !isRecord(suite) ||
            suite["package-name"] !== "portcove-core" ||
            !id ||
            id.length >= 4096
          )
            throw new Error("Invalid qualification Core binary inventory");
          return [id, suite["package-name"], suite["binary-id"]];
        }),
    ),
  );
}

export function windowsPartitionOutcomeSelection(inventory: unknown, tests: readonly string[]) {
  assertSameIdentities(
    runnableWindowsRustTests(inventory, { allowSkipped: true }),
    tests,
    "Transferred partition",
  );
  return nextestOutcomeSelection(inventory, new Set(tests));
}

export function buildWindowsRustArchive() {
  const { plan, identity } = currentContext();
  if (plan.mode === "qualification") return buildQualificationCoreArchive(identity);
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
  const { plan, identity } = currentContext();
  if (plan.mode !== "fast") throw new Error("Ordinary Windows partitions require a fast plan");
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
  const completeInventory = metrics.measure("windows-test-extract-and-inventory", () =>
    listInventory([
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
    ]),
  );
  const complete = runnableWindowsRustTests(completeInventory);
  assertSameIdentities(complete, manifest.complete, "Transferred workspace");
  const skipErrors = writeWindowsRustSkipRoutes(
    path.join(windowsRustSkipResultsDirectory, `partition-${partition.id}`),
    completeInventory,
    identity,
  );
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
  const inventory: unknown = JSON.parse(
    execute("cargo-nextest", ["nextest", "list", ...args, "--message-format", "json"]),
  );
  const selection = windowsPartitionOutcomeSelection(inventory, partition.tests);
  const result = metrics.measure("selected-rust-tests", () => ({
    status: runNextestWithOutcomes(args, selection),
  }));
  if (result.status !== 0) throw new Error(`Nextest partition failed with status ${result.status}`);
  if (skipErrors.length) throw new Error(skipErrors.join("; "));
}

const qualificationDirectory = path.join(root, "work", "windows-rust-qualification");

function buildQualificationCoreArchive(identity: ArchiveIdentity) {
  const metrics = createCiMetrics();
  mkdirSync(qualificationDirectory, { recursive: true });
  const binaries = path.join(qualificationDirectory, "binaries.json");
  const cargo = path.join(qualificationDirectory, "cargo.json");
  metrics.measure("qualification-core-build", () => {
    writeFileSync(
      binaries,
      execute("cargo-nextest", [
        "nextest",
        "list",
        ...qualificationCoreScope,
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
    qualificationCoreProfile,
  ];
  const snapshots = [binaries, cargo].map((file) => ({ file, sha256: fileDigest(file) }));
  const verify = () => {
    for (const { file, sha256 } of snapshots)
      if (fileDigest(file) !== sha256) throw new Error("Qualification Core metadata changed");
  };
  const completeInventory = listInventory([...metadata, "-E", "all()"]);
  const complete = runnableWindowsRustTests(completeInventory);
  const workers: QualificationCoreWorkerInventory[] = [];
  for (const worker of qualificationCoreWorkers()) {
    const phases = [];
    for (const phase of worker.phases) {
      verify();
      // The old executable argv is the independent selection oracle. These are
      // warm Cargo freshness checks, with exactly the same Core build scope.
      const original = metrics.measure(`qualification-original-${worker.name}-${phase.name}`, () =>
        listTests([
          ...phase.arguments.slice(0, qualificationCoreScope.length),
          "--profile",
          qualificationCoreProfile,
          ...phase.arguments.slice(qualificationCoreScope.length),
        ]),
      );
      const transferred = listTests([...metadata, ...reusedQualificationArguments(phase)]);
      assertSameIdentities(transferred, [...original], `Original ${worker.name}/${phase.name}`);
      if (!original.size) throw new Error(`Empty qualification phase ${worker.name}/${phase.name}`);
      phases.push({ ...phase, tests: [...original].sort(ordered) });
      verify();
    }
    workers.push({ name: worker.name, phases });
  }
  const archive = path.join(qualificationDirectory, "tests.tar.zst");
  metrics.measure("qualification-core-archive", () =>
    execute(
      "cargo-nextest",
      ["nextest", "archive", ...qualificationCoreScope, "--archive-file", archive],
      false,
    ),
  );
  verify();
  const manifest: WindowsQualificationCoreManifest = {
    format_version: 2,
    identity,
    profile: qualificationCoreProfile,
    scope: [...qualificationCoreScope],
    archive_sha256: fileDigest(archive),
    binaries_sha256: qualificationBinaryListDigest(completeInventory),
    complete: [...complete].sort(ordered),
    workers,
  };
  validateWindowsQualificationCoreManifest(manifest, identity);
  const bytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(path.join(qualificationDirectory, "manifest.json"), bytes, { flag: "wx" });
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing qualification producer output channel");
  appendFileSync(process.env.GITHUB_OUTPUT, `manifest_sha256=${digest(bytes)}\n`);
  metrics.record("qualification-core-selection", {
    complete_tests: complete.size,
    selected_tests: complete.size,
  });
  for (const worker of workers)
    for (const phase of worker.phases)
      console.log(
        `[qualification-core] ${worker.name}/${phase.name}: ${phase.tests.length} selected tests`,
      );
}

export function runWindowsQualificationCoreWorker(workerName: string) {
  const { plan, identity } = currentContext();
  if (plan.mode !== "qualification")
    throw new Error("Qualification Core workers require a qualification plan");
  const { manifest, archive } = readWindowsQualificationCorePacket(
    qualificationDirectory,
    identity,
    process.env.PORTCOVE_WINDOWS_MANIFEST_SHA256,
  );
  const worker = manifest.workers.find(({ name }) => name === workerName);
  if (!worker) throw new Error("Unknown qualification Core worker");
  const metrics = createCiMetrics();
  const extracted = path.join(root, "work", "windows-qualification-extracted");
  mkdirSync(extracted, { recursive: true });
  const completeInventory = metrics.measure("qualification-core-extract-and-inventory", () =>
    listInventory([
      "--archive-file",
      archive,
      "--extract-to",
      extracted,
      "--workspace-remap",
      root,
      "--profile",
      qualificationCoreProfile,
      "-E",
      "all()",
    ]),
  );
  if (qualificationBinaryListDigest(completeInventory) !== manifest.binaries_sha256)
    throw new Error("Transferred qualification Core binary inventory differs");
  const complete = runnableWindowsRustTests(completeInventory);
  assertSameIdentities(complete, manifest.complete, "Transferred qualification Core");
  const skipErrors = writeWindowsRustSkipRoutes(
    path.join(windowsRustSkipResultsDirectory, `core-${worker.name}`),
    completeInventory,
    identity,
    { coreOnly: true },
  );
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
    "--profile",
    qualificationCoreProfile,
  ];
  for (const phase of worker.phases) {
    const config = path.join(qualificationDirectory, `execute-${worker.name}-${phase.name}.toml`);
    writeFileSync(
      config,
      windowsPartitionConfig(
        readFileSync(path.join(root, ".config/nextest.toml"), "utf8"),
        phase.tests,
        qualificationCoreProfile,
      ),
      { flag: "wx" },
    );
    const args = [...metadata, "--config-file", config];
    const inventory: unknown = JSON.parse(
      execute("cargo-nextest", ["nextest", "list", ...nextestListArguments(args)]),
    );
    const selection = windowsPartitionOutcomeSelection(inventory, phase.tests);
    const result = metrics.measure(`qualification-core-${worker.name}-${phase.name}`, () => ({
      status: runNextestWithOutcomes(args, selection),
    }));
    if (result.status !== 0)
      throw new Error(`Qualification Core phase failed with status ${result.status}`);
  }
  if (skipErrors.length) throw new Error(skipErrors.join("; "));
}

/** Refuse unbound, truncated or substituted packets before invoking nextest. */
export function readWindowsQualificationCorePacket(
  directory: string,
  identity: ArchiveIdentity,
  expectedManifestSha256: string | undefined,
) {
  const manifestFile = path.join(directory, "manifest.json");
  if (fileDigest(manifestFile) !== expectedManifestSha256)
    throw new Error("Qualification Core manifest differs from this producer's output");
  const manifest = validateWindowsQualificationCoreManifest(readJson(manifestFile), identity);
  const archive = path.join(directory, "tests.tar.zst");
  if (fileDigest(archive) !== manifest.archive_sha256)
    throw new Error("Qualification Core archive digest mismatch");
  return { manifest, archive };
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
      else if (process.argv[2] === "run-qualification" && process.argv.length === 4)
        runWindowsQualificationCoreWorker(process.argv[3]!);
      else
        throw new Error(
          "Use windows-rust-tests.mts build, run <partition> or run-qualification <worker>",
        );
      return 0;
    });
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
