import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePhysicalPath } from "./dev-storage.mts";
import { runResourceCommand } from "./resource-command.mts";
import { readCoverageMaps } from "./coverage-maps.mts";
import { parse } from "yaml";
import { workspacePackageDeclaration } from "./workspace-package-declaration.mts";
import { isRecord } from "./runtime-values.mts";
import {
  parseCoverageArguments,
  boundedCoverageRead,
  coverageCustody,
  assertCoverageCustody,
  type CoveragePacket,
  type CoverageRequest,
} from "./test-coverage-config.mts";

const executorRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const normalized = (file: string) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

function runtimeIdentity(root: string, request: CoverageRequest) {
  const pin = readFileSync(path.join(root, ".node-version"), "utf8").trim();
  if (process.version !== `v${pin}`)
    throw new Error(`Coverage requires repository-pinned Node ${pin}`);
  if (request.mode === "node") return { node: process.version, backend: "node-native-v8" };
  const require = createRequire(path.join(root, "package.json"));
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const provider: unknown = JSON.parse(
    readFileSync(require.resolve("@vitest/coverage-v8/package.json"), "utf8"),
  );
  const runnerRequire = createRequire(require.resolve("vite-plus/test/node"));
  const runner: unknown = JSON.parse(
    readFileSync(runnerRequire.resolve("vitest/package.json"), "utf8"),
  );
  const declaration =
    isRecord(manifest) && isRecord(manifest.devDependencies)
      ? manifest.devDependencies["@vitest/coverage-v8"]
      : undefined;
  const workspace: unknown =
    declaration === "catalog:"
      ? parse(
          boundedCoverageRead(path.join(root, "pnpm-workspace.yaml"), 1024 * 1024).toString("utf8"),
        )
      : undefined;
  const providerPin = workspacePackageDeclaration(workspace, "@vitest/coverage-v8", declaration);
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.devDependencies) ||
    !isRecord(provider) ||
    !isRecord(runner) ||
    typeof provider.version !== "string" ||
    providerPin !== provider.version ||
    provider.version !== runner.version
  )
    throw new Error(
      "Coverage provider must match the pinned installed Vitest runtime; run repository dependency setup",
    );
  return {
    node: process.version,
    backend: "vitest-v8",
    provider: provider.version,
    vitest: runner.version,
  };
}

function measuredCounters(file: Record<string, unknown>, node: boolean) {
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (node) {
    for (const key of ["branches", "functions", "lines"])
      if (
        !Array.isArray(file[key]) ||
        !file[key].every((row: unknown) => isRecord(row) && count(row.count) && count(row.line))
      )
        throw new Error("Invalid Node coverage counters or source locations");
    for (const key of [
      "totalBranchCount",
      "coveredBranchCount",
      "totalFunctionCount",
      "coveredFunctionCount",
      "totalLineCount",
      "coveredLineCount",
    ])
      if (!count(file[key])) throw new Error("Invalid Node coverage totals");
  } else {
    const branches = file.b,
      locations = file.branchMap,
      statements = file.s;
    if (
      !isRecord(branches) ||
      !isRecord(locations) ||
      !isRecord(statements) ||
      !isRecord(file.statementMap)
    )
      throw new Error("Invalid frontend coverage maps");
    if (
      Object.keys(branches).some((key) => !Object.hasOwn(locations, key)) ||
      Object.keys(locations).some((key) => !Object.hasOwn(branches, key)) ||
      !Object.values(branches).every((row) => Array.isArray(row) && row.every(count)) ||
      !Object.values(statements).every(count)
    )
      throw new Error("Invalid frontend branch or statement counters");
  }
}

function createPacket(root: string, request: CoverageRequest) {
  const parent = path.join(root, "work/test-coverage");
  const relative = path.relative(realpathSync(root), resolvePhysicalPath(parent));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Coverage output resolves outside the workspace");
  mkdirSync(parent, { recursive: true });
  const directory = path.join(parent, randomUUID());
  mkdirSync(directory);
  mkdirSync(path.join(directory, "coverage"));
  mkdirSync(path.join(directory, "maps"));
  const packet: CoveragePacket = {
    format_version: 1,
    root: realpathSync(root),
    directory,
    request,
    node: process.version,
    custody: coverageCustody(directory),
  };
  writeFileSync(path.join(directory, "request.json"), JSON.stringify(packet, null, 2) + "\n", {
    flag: "wx",
  });
  return packet;
}

function retainSources(packet: CoveragePacket) {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: packet.root,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  const sources = [
    ...new Set([...packet.request.modules, ...packet.request.tests, ".node-version"]),
  ].map((file) => {
    const bytes = boundedCoverageRead(path.join(packet.root, file), 1024 * 1024);
    const copy = path.join(packet.directory, "observed-source", file);
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, bytes, { flag: "wx" });
    return { file, sha256: digest(bytes), bytes: bytes.length };
  });
  const executor = [
    "scripts/test-coverage.mts",
    "scripts/test-coverage-config.mts",
    "scripts/workspace-package-declaration.mts",
    "scripts/coverage-node-reporter.mts",
    "scripts/coverage-node-loader.mts",
    "scripts/coverage-maps.mts",
    "scripts/required-node-test-reporter.mts",
    "scripts/test-duration-reporter.mts",
    "scripts/node-case-observations.mts",
    "scripts/runtime-values.mts",
    "scripts/node-platform-skips.mts",
    "scripts/node-test-suites.mts",
    "scripts/node-test-suites.json",
    "scripts/run-ui-tests.mts",
    "scripts/ui-test-selection.mts",
    "apps/desktop/src/browser/failure-probe-contract.ts",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
  ].map((file) => {
    const bytes = boundedCoverageRead(path.join(executorRoot, file), 4 * 1024 * 1024);
    const copy = path.join(packet.directory, "executor-source", file);
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, bytes, { flag: "wx" });
    return { file, sha256: digest(bytes), bytes: bytes.length };
  });
  return {
    head: git("rev-parse", "HEAD").trim(),
    tree: git("rev-parse", "HEAD^{tree}").trim(),
    status: git("status", "--porcelain=v1", "--untracked-files=normal"),
    sources,
    executor,
    scope:
      "Selected source/executor bytes and original Git state; this is not an attestation of every transitive input",
  };
}

export function coverageCommand(packet: CoveragePacket) {
  if (packet.request.mode !== "node")
    return [path.join(executorRoot, "scripts/run-ui-tests.mts"), "exact", ...packet.request.tests];
  return [
    "--test",
    "--test-concurrency=1",
    "--test-timeout=60000",
    "--enable-source-maps",
    "--experimental-test-module-mocks",
    "--import=" + pathToFileURL(path.join(executorRoot, "scripts/coverage-node-loader.mts")).href,
    "--experimental-test-coverage",
    ...packet.request.modules.map((file) => `--test-coverage-include=${file}`),
    `--test-reporter=${pathToFileURL(path.join(executorRoot, "scripts/coverage-node-reporter.mts")).href}`,
    ...packet.request.tests.map((file) => path.join(packet.root, file)),
  ];
}

export function readMeasuredCoverage(packet: CoveragePacket) {
  assertCoverageCustody(packet);
  const filename = path.join(
    packet.directory,
    "coverage",
    packet.request.mode === "node" ? "node-coverage.json" : "coverage-final.json",
  );
  const bytes = boundedCoverageRead(filename, 32 * 1024 * 1024);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value)) throw new Error("Invalid measured coverage report");
  const files =
    packet.request.mode === "node" && isRecord(value.summary) && Array.isArray(value.summary.files)
      ? value.summary.files
      : packet.request.mode !== "node"
        ? Object.values(value)
        : [];
  if (!files.length || !files.every((file) => isRecord(file) && typeof file.path === "string"))
    throw new Error("Measured coverage has no valid source files");
  const expected = new Map(
    packet.request.modules.map((file) => [normalized(path.join(packet.root, file)), file]),
  );
  const observed = new Map<string, unknown>();
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== "string") throw new Error("Invalid coverage file");
    const identity = normalized(file.path),
      relative = expected.get(identity);
    if (!relative || observed.has(identity))
      throw new Error("Coverage contains an unselected or duplicate module");
    measuredCounters(file, packet.request.mode === "node");
    observed.set(identity, file);
  }
  const lcov = path.join(packet.directory, "coverage/lcov.info");
  const lcovBytes = boundedCoverageRead(lcov, 32 * 1024 * 1024);
  if (!lcovBytes.length || lcovBytes.length > 32 * 1024 * 1024)
    throw new Error("Missing or oversized LCOV source report");
  return {
    mappings: readCoverageMaps(packet),
    file: filename,
    sha256: digest(bytes),
    lcov: { file: lcov, sha256: digest(lcovBytes) },
    modules: [...observed].map(([identity, detail]) => ({ file: expected.get(identity)!, detail })),
    missing: [...expected].filter(([identity]) => !observed.has(identity)).map(([, file]) => file),
  };
}

interface CoverageExecution {
  args: string[];
  root: string;
  environment: NodeJS.ProcessEnv;
  stdout: number;
  stderr: number;
}
type ExecuteCoverage = (execution: CoverageExecution) => Promise<number>;

async function admittedExecution(execution: CoverageExecution) {
  return runResourceCommand(
    execution.environment.PORTCOVE_COVERAGE_MODE === "node" ? "analysis" : "browser",
    process.execPath,
    execution.args,
    {
      cwd: execution.root,
      environment: execution.environment,
      output: { stdout: execution.stdout, stderr: execution.stderr },
      executionTimeoutMilliseconds: 20 * 60_000,
      queueDeadline: performance.now() + 15 * 60_000,
    },
  );
}

/** The injected executor is only the admission boundary; fixtures still run the real pinned backend. */
export async function runMeasuredCoverage(
  root: string,
  request: CoverageRequest,
  execute: ExecuteCoverage = admittedExecution,
  environment = process.env,
) {
  root = realpathSync(root);
  const runtime = runtimeIdentity(root, request),
    packet = createPacket(root, request),
    source = retainSources(packet);
  // Hold the owned file open before children run, including through a directory replacement.
  const receiptDescriptor = openSync(path.join(packet.directory, "receipt.json"), "wx");
  try {
    const filename = path.join(packet.directory, "request.json");
    const childEnvironment: NodeJS.ProcessEnv = {
      ...environment,
      PORTCOVE_COVERAGE_MODE: request.mode,
    };
    // Do not inherit another investigation's raw V8 directory into workers or subprocess fixtures.
    delete childEnvironment.NODE_V8_COVERAGE;
    delete childEnvironment.NODE_TEST_CONTEXT;
    delete childEnvironment.PORTCOVE_NODE_COVERAGE_PACKET;
    delete childEnvironment.PORTCOVE_UI_COVERAGE_PACKET;
    childEnvironment[
      request.mode === "node" ? "PORTCOVE_NODE_COVERAGE_PACKET" : "PORTCOVE_UI_COVERAGE_PACKET"
    ] = filename;
    const stages: { name: string; args: string[]; status: number | null; error?: string }[] = [];
    const commands = [
      ...(request.mode === "frontend-browser"
        ? [
            {
              name: "browser-bootstrap",
              args: [path.join(root, "apps/desktop/scripts/browser-runtime.mts"), "bootstrap"],
            },
          ]
        : []),
      { name: "tests", args: coverageCommand(packet) },
    ];
    let originalStatus: number | null = null,
      failure: string | null = null;
    for (const command of commands) {
      assertCoverageCustody(packet);
      const stdout = openSync(path.join(packet.directory, `${command.name}.stdout.log`), "wx");
      const stderr = openSync(path.join(packet.directory, `${command.name}.stderr.log`), "wx");
      try {
        originalStatus = await execute({
          args: command.args,
          root,
          environment: childEnvironment,
          stdout,
          stderr,
        });
        stages.push({ name: command.name, args: command.args, status: originalStatus });
      } catch (error) {
        originalStatus = null;
        failure = String(error);
        stages.push({ name: command.name, args: command.args, status: null, error: failure });
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
      if (originalStatus !== 0) break;
    }
    let coverage: ReturnType<typeof readMeasuredCoverage> | null = null;
    try {
      coverage = readMeasuredCoverage(packet);
    } catch (error) {
      failure ??= String(error);
    }
    const matches = (base: string, file: { file: string; sha256: string }) => {
      try {
        return (
          digest(boundedCoverageRead(path.join(base, file.file), 4 * 1024 * 1024)) === file.sha256
        );
      } catch {
        return false;
      }
    };
    const changed = [
      ...source.sources.filter((file) => !matches(root, file)).map((file) => file.file),
      ...source.executor
        .filter((file) => !matches(executorRoot, file))
        .map((file) => `executor:${file.file}`),
    ];
    const complete =
      originalStatus === 0 &&
      coverage !== null &&
      coverage.missing.length === 0 &&
      changed.length === 0 &&
      failure === null;
    const status = originalStatus ?? 1;
    const exitStatus = status || (complete ? 0 : 1);
    const receipt = {
      format_version: 1,
      scope: request.mode,
      request,
      runtime,
      platform: process.platform,
      arch: process.arch,
      source,
      stages,
      original_exit_status: originalStatus,
      exit_status: exitStatus,
      complete,
      changed_sources: changed,
      failure,
      receipt_write_error: null as string | null,
      coverage,
      limits:
        "Selected modules only; fixture/generated code excluded from the measured selection. Node, frontend unit and Chromium reports establish separate scopes. No percentage gate or native/package acceptance.",
    };
    try {
      writeFileSync(receiptDescriptor, JSON.stringify(receipt, null, 2) + "\n");
    } catch (error) {
      receipt.receipt_write_error = String(error);
      receipt.complete = false;
      receipt.exit_status = originalStatus || 1;
      console.error(
        `Coverage receipt write failed; original status ${originalStatus}: ${String(error)}`,
      );
    }
    return { directory: packet.directory, status: receipt.exit_status, receipt };
  } finally {
    closeSync(receiptDescriptor);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2]!)) {
    console.log(
      "Usage: test-coverage.mts node|frontend-unit|frontend-browser --module FILE --test FILE [--module FILE --test FILE ...]",
    );
  } else {
    const request = parseCoverageArguments(process.argv.slice(2), executorRoot);
    const result = await runMeasuredCoverage(executorRoot, request);
    console.log(
      `Coverage ${result.receipt.complete ? "complete" : "incomplete"}; original command status ${result.receipt.original_exit_status}; retained ${result.directory}`,
    );
    process.exitCode = result.status;
  }
}
