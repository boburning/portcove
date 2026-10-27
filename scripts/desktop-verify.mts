#!/usr/bin/env node
import { operationCoverage, readCoverageInput } from "./operation-coverage.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import type { DesktopSelection } from "./desktop-scenarios.mts";
import type { StoragePaths } from "./dev-storage.mts";

import { planDesktopExecution } from "./desktop-execution-plan.mts";
import { createRequire } from "node:module";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { collectDoctor } from "./dev-doctor.mts";
import {
  childEnvironment,
  getPaths,
  minimumFreeGiB,
  preflight,
  spawnCommand,
} from "./dev-storage.mts";
import {
  catalogReport,
  desktopHarnessDeadlineMs,
  DESKTOP_PROFILES,
  resolveDesktopSelection,
} from "./desktop-scenarios.mts";
import { acquireNativeSessionLock } from "./native-session-lock.mts";
import { cachedDesktopDrivers, readToolPins } from "./tool-cache.mts";
import { frontendCommandPlan, probeFrontendCommand } from "./frontend-command-preflight.mts";
import { resourceEntrypoint } from "./resource-command.mts";
import { frontendOutputResource } from "./resource-capacity.mts";
import {
  createFrontendBuildIdentity,
  observeFrontendBuild,
  createVerificationBuildIdentity,
} from "./desktop-build-cache.mts";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
// Forward declarations as untrusted metadata; the evidence consumer owns validation.
function readAcceptanceBindings(text: string): unknown {
  return JSON.parse(text);
}

export const desktopVerifyUsage = `usage: just desktop-verify [--profile PROFILE | --scenario ID ...] [options]

Selection:
  --profile smoke|presentation|restart|artwork|owned-lifecycle|full
  --scenario ID                 Repeat for an exact focused series
  --list-scenarios              List stable IDs and requirements
  --qualification-evidence FILE Add actual Core offered-operation coverage to the list
  --current-preflight FILE      Requested frozen dependencies for one scope (repeatable)
  --acceptance-packet FILE      Completed receipt to revalidate (repeatable)

Options:
  --restart-cycles 1..10        Default: 1
  --reload-cycles 0..25         Default: 0; positive values opt profiles into reload
  --require-clean               Refuse a dirty source tree
  --acceptance-bindings-file ABS Optional finite qualification declarations/review; no new gate
  --plan                        Resolve without building or launching
  --json                        Machine output for --plan or --list-scenarios
  --help`;

export function desktopBuildEnvironment(
  environment: NodeJS.ProcessEnv,
  selection: DesktopSelection,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (planDesktopExecution(selection).fixtures.designCompatibility)
    result.VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE = "1";
  return result;
}

export function desktopVerificationOutputResources(
  paths: Pick<StoragePaths, "workspace" | "target_directory">,
) {
  if (!paths.target_directory)
    throw new Error("Desktop verification requires resolved Rust target storage");
  return [...new Set([paths.workspace, paths.target_directory].map(frontendOutputResource))];
}

export function checkpointTestNames(listing: string) {
  const names = [...listing.matchAll(/^(qualification_checkpoint::tests::\S+): test\r?$/gmu)].map(
    (match) => match[1] ?? "",
  );
  const total = listing.match(/^(\d+) tests?, (\d+) benchmarks?\r?$/mu);
  if (
    !names.length ||
    new Set(names).size !== names.length ||
    Number(total?.[1]) !== names.length ||
    Number(total?.[2]) !== 0
  )
    throw new Error("Checkpoint feature test inventory is empty, incomplete or duplicated");
  return names;
}

export function requireCheckpointTestExecution(names: readonly string[], output: string) {
  const passed = [
    ...output.matchAll(/^test (qualification_checkpoint::tests::\S+) \.\.\. ok\r?$/gmu),
  ].map((match) => match[1] ?? "");
  const summary = output.match(
    /^test result: ok\. (\d+) passed; 0 failed; 0 ignored; 0 measured;/mu,
  );
  if (
    !names.length ||
    new Set(passed).size !== passed.length ||
    Number(summary?.[1]) !== names.length ||
    passed.length !== names.length ||
    names.some((name) => !passed.includes(name))
  )
    throw new Error("Checkpoint feature tests did not execute their complete selected inventory");
}

export function parseDesktopVerifyArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", default: false },
      profile: { type: "string" },
      scenario: { type: "string", multiple: true, default: [] },
      "list-scenarios": { type: "boolean", default: false },
      "qualification-evidence": { type: "string" },
      "current-preflight": { type: "string", multiple: true, default: [] },
      "acceptance-packet": { type: "string", multiple: true, default: [] },
      "restart-cycles": { type: "string", default: "1" },
      "reload-cycles": { type: "string", default: "0" },
      "require-clean": { type: "boolean", default: false },
      "acceptance-bindings-file": { type: "string" },
      plan: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  if (
    (values["qualification-evidence"] ||
      values["current-preflight"].length ||
      values["acceptance-packet"].length) &&
    !values["list-scenarios"]
  )
    throw new Error("Coverage inputs require --list-scenarios");
  if (
    (values["current-preflight"].length || values["acceptance-packet"].length) &&
    !values["qualification-evidence"]
  )
    throw new Error("Receipt inputs require --qualification-evidence");
  const restartCycles = Number(values["restart-cycles"]);
  const reloadCycles = Number(values["reload-cycles"]);
  if (!Number.isInteger(restartCycles) || restartCycles < 1 || restartCycles > 10)
    throw new Error("--restart-cycles must be 1..10");
  if (!Number.isInteger(reloadCycles) || reloadCycles < 0 || reloadCycles > 25)
    throw new Error("--reload-cycles must be 0..25");
  if (values.json && !values.plan && !values["list-scenarios"])
    throw new Error("--json is supported only with --plan or --list-scenarios");
  if (values.plan && values["list-scenarios"]) throw new Error("Choose --plan or --list-scenarios");
  if (values["list-scenarios"] && (values.profile || values.scenario.length))
    throw new Error("--list-scenarios cannot be combined with a selection");
  return {
    help: values.help,
    profile: values.profile,
    scenarios: values.scenario,
    listScenarios: values["list-scenarios"],
    ...(values["qualification-evidence"]
      ? {
          operationCoverageInputs: {
            qualification: values["qualification-evidence"],
            currentPreflights: values["current-preflight"],
            packets: values["acceptance-packet"],
          },
        }
      : {}),
    restartCycles,
    reloadCycles,
    requireClean: values["require-clean"],
    ...(values["acceptance-bindings-file"]
      ? { acceptanceBindingsFile: values["acceptance-bindings-file"] }
      : {}),
    plan: values.plan,
    json: values.json,
  };
}

function sourceState() {
  const revision = spawnCommand("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim();
  const status = spawnCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (status.status !== 0) throw new Error("Unable to inspect the source tree");
  return { revision, clean: !status.stdout.trim() };
}

function workspacePackageStatus() {
  try {
    const require = createRequire(path.join(root, "apps", "desktop", "package.json"));
    return { ready: true, selenium: require.resolve("selenium-webdriver") };
  } catch {
    return {
      ready: false,
      selenium: null,
      remediation: `node scripts/dev-storage.mts run -- pnpm install --frozen-lockfile`,
    };
  }
}

function executableSuffix(platform = process.platform) {
  return platform === "win32" ? ".exe" : "";
}

// Source/package observations are forwarded unchanged. Preserve each caller's
// actual projection rather than claim that planning executes those prerequisites.
export function buildDesktopVerifyPlan<Source extends { revision: string }, Packages>({
  selection,
  paths,
  drivers,
  source,
  packages,
  frontendCommand,
}: {
  selection: DesktopSelection;
  paths: Pick<StoragePaths, "output_root" | "target_directory">;
  drivers: Pick<
    NonNullable<ReturnType<typeof cachedDesktopDrivers>>,
    "driver" | "nativeDriver"
  > | null;
  source: Source;
  packages: Packages;
  frontendCommand?: ReturnType<typeof frontendCommandPlan> | undefined;
}) {
  if (!paths.target_directory)
    throw new Error("Desktop verification requires resolved Rust target storage");
  const execution = planDesktopExecution(selection);
  const suffix = executableSuffix();
  const ownedFixture = execution.fixtures.owned;
  return {
    format_version: 1,
    profile: selection.profile,
    requested_scenarios: selection.requested_scenarios,
    selected_scenarios: selection.selected_scenarios,
    setup_scenarios: selection.setup_scenarios,
    excluded_scenarios: selection.excluded_scenarios,
    known_gaps: selection.known_gaps,
    harness_deadline_ms: desktopHarnessDeadlineMs(selection),
    prerequisites: selection.prerequisites,
    host_resources: selection.host_resources,
    cli_features: execution.build.cliFeatures,
    qualification_features: execution.build.qualificationFeatures,
    required_output_resources: desktopVerificationOutputResources({ workspace: root, ...paths }),
    source,
    workspace_packages: packages,
    frontend_command: frontendCommand,
    drivers: drivers
      ? { ready: true, driver: drivers.driver, native_driver: drivers.nativeDriver }
      : {
          ready: false,
          remediation:
            process.platform === "win32"
              ? "./scripts/bootstrap-quality-tools.ps1 -Desktop"
              : "./scripts/bootstrap-quality-tools.sh --desktop",
        },
    paths: {
      output_parent: path.join(paths.output_root, "desktop-verify"),
      application: path.join(paths.target_directory, "debug", `portcove-desktop${suffix}`),
      cli: ownedFixture ? path.join(paths.target_directory, "debug", `portcove${suffix}`) : null,
      owned_probe: ownedFixture ? `<run-directory>/portcove-host-tool-fixture${suffix}` : null,
    },
    phases: [
      "workspace-package-preflight",
      "desktop-doctor",
      "frontend-command-preflight",
      ...(ownedFixture ? ["scenario-context-preflight"] : []),
      ...(execution.build.qualificationFeatures.includes("qualification-fixtures")
        ? ["checkpoint-feature-inventory", "checkpoint-feature-tests"]
        : []),
      "frontend-build",
      "desktop-build",
      ...(ownedFixture ? ["cli-build", "owned-probe-build"] : []),
      "native-harness",
    ],
  };
}

async function printCatalog(
  asJson: boolean,
  inputs?: {
    qualification: string;
    currentPreflights: readonly string[];
    packets: readonly string[];
  },
) {
  const coverage = inputs
    ? await operationCoverage(
        (await readCoverageInput(inputs.qualification)).value,
        await Promise.all(
          inputs.packets.map(async (file) => (await readCoverageInput(file)).identity),
        ),
        await Promise.all(
          inputs.currentPreflights.map(async (file) => (await readCoverageInput(file)).value),
        ),
      )
    : undefined;
  const report = {
    format_version: 1,
    profiles: DESKTOP_PROFILES,
    scenarios: catalogReport(),
    ...(coverage ? { operation_coverage: coverage } : {}),
  };
  if (asJson) return console.log(JSON.stringify(report, null, 2));
  if (coverage) console.log(JSON.stringify({ operation_coverage: coverage }, null, 2));
  console.log("Native desktop scenarios:");
  for (const item of report.scenarios) {
    const runnable = item.runnable ? "runnable" : `gap: ${item.reason}`;
    console.log(`  ${item.id} — ${item.description}`);
    console.log(
      `    ${runnable}; profiles ${item.profiles.join(", ") || "none"}; prerequisites ${item.prerequisites.join(", ")}`,
    );
  }
}

async function unusedPort(port: number) {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function findUnusedDesktopPortPair(start = 4444) {
  for (let port = start; port <= 65533; port += 2) {
    try {
      await unusedPort(port);
      await unusedPort(port + 1);
      return port;
    } catch {
      // Continue to the next consecutive pair. The native harness rechecks before launch.
    }
  }
  throw new Error("No unused consecutive desktop-driver ports were found");
}

function doctorRemediation(report: Awaited<ReturnType<typeof collectDoctor>>) {
  return report.tools
    .filter((tool) => tool.required && tool.status !== "ok")
    .map(
      (tool) => `${tool.id}: ${tool.status}; remedy ${tool.remediation ?? "inspect just doctor"}`,
    )
    .join("; ");
}

interface PhaseTiming {
  phase: string;
  started_at: string;
  finished_at: string;
  status: number;
  duration_ms?: number;
  frontend_observation?: Awaited<ReturnType<typeof observeFrontendBuild>>;
}
async function executePhase({
  id,
  command,
  args,
  cwd,
  environment,
  log,
  timings,
}: {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  log: string;
  timings: PhaseTiming[];
}) {
  const started = new Date();
  console.log(`desktop-verify: ${id}`);
  const cargo = ["cargo", "rustc"].includes(command);
  const native = id === "native-harness";
  const guardedArgs = cargo
    ? ["scripts/run-rust-tests.mts", "--guard-command", command, ...args]
    : native
      ? ["scripts/resource-command.mts", "browser", "--", command, ...args]
      : args;
  const guardedCommand = cargo || native ? process.execPath : command;
  const result = spawnCommand(guardedCommand, guardedArgs, {
    cwd,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const finished = new Date();
  const timing = {
    phase: id,
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - started.getTime(),
    status: result.status ?? 1,
  };
  timings.push(timing);
  await appendFile(
    log,
    `${JSON.stringify({ ...timing, command: [command, ...args] })}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.status !== 0) throw new Error(`${id} failed with exit code ${result.status}`);
  return result.stdout ?? "";
}

export async function acquireDesktopVerifySession<
  Lock = Awaited<ReturnType<typeof acquireNativeSessionLock>>,
>({
  runDirectory,
  environment,
  selection,
  timings,
  probe = probeFrontendCommand,
  acquire,
}: {
  runDirectory: string;
  environment: NodeJS.ProcessEnv;
  selection: Pick<DesktopSelection, "selected_scenarios"> & {
    profile?: DesktopSelection["profile"];
  };
  timings: PhaseTiming[];
  probe?: typeof probeFrontendCommand;
  acquire?: (
    metadata: NonNullable<Parameters<typeof acquireNativeSessionLock>[0]>,
  ) => Promise<Lock>;
}) {
  const receipt = probe({ cwd: path.join(root, "apps", "desktop"), environment });
  await writeFile(
    path.join(runDirectory, "frontend-command-preflight.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  timings.push({
    phase: "frontend-command-preflight",
    started_at: receipt.started_at,
    finished_at: receipt.finished_at,
    status: receipt.ready ? 0 : 1,
  });
  if (!receipt.ready) throw new Error(receipt.message);
  if (typeof receipt.observed_version !== "string")
    throw new Error("Ready frontend receipt must contain the observed version");
  const lock = await (acquire ?? acquireNativeSessionLock)({
    workspace: root,
    ...(selection.profile === undefined ? {} : { profile: selection.profile }),
    scenarios: selection.selected_scenarios,
  });
  return { lock, vitePlusVersion: receipt.observed_version };
}

async function runVerification(
  options: ReturnType<typeof parseDesktopVerifyArgs>,
  selection: DesktopSelection,
) {
  const configuredPaths = getPaths();
  const storage = preflight(configuredPaths, minimumFreeGiB());
  const paths = storage.paths;
  const source = sourceState();
  if (options.requireClean && !source.clean)
    throw new Error("--require-clean refused the dirty source tree");
  const packageStarted = new Date();
  const packages = workspacePackageStatus();
  const packageFinished = new Date();
  const drivers = cachedDesktopDrivers();
  const environment = desktopBuildEnvironment(childEnvironment(paths), selection);
  const pins = readToolPins();
  const frontendCommand = frontendCommandPlan({
    cwd: path.join(root, "apps", "desktop"),
  });
  const plan = buildDesktopVerifyPlan({
    selection,
    paths,
    drivers,
    source,
    packages,
    frontendCommand,
  });
  if (options.plan) {
    if (options.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Desktop verification plan: ${selection.profile ?? "exact scenarios"}`);
      console.log(`Selected: ${selection.selected_scenarios.join(", ")}`);
      console.log(`Setup: ${selection.setup_scenarios.join(", ") || "none"}`);
      console.log(`Harness deadline: ${plan.harness_deadline_ms} ms`);
      console.log(
        `Known gaps: ${selection.known_gaps.map((item) => item.scenario).join(", ") || "none"}`,
      );
      console.log(`Phases: ${plan.phases.join(" -> ")}`);
      console.log(`Application: ${plan.paths.application}`);
      console.log(`Output parent: ${plan.paths.output_parent}`);
      console.log(
        `Workspace packages: ${packages.ready ? "ready" : `missing; remedy ${packages.remediation}`}`,
      );
      console.log(`Drivers: ${drivers ? "ready" : `missing; remedy ${plan.drivers.remediation}`}`);
      console.log(
        `Frontend local Vite+ command file: ${frontendCommand.command_file ?? "unavailable"}; version not observed (plan only)`,
      );
    }
    return;
  }

  await mkdir(plan.paths.output_parent, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDirectory = await mkdtemp(path.join(plan.paths.output_parent, `${stamp}-`));
  const log = path.join(runDirectory, "phase.log");
  const timings: PhaseTiming[] = [
    {
      phase: "workspace-package-preflight",
      started_at: packageStarted.toISOString(),
      finished_at: packageFinished.toISOString(),
      duration_ms: packageFinished.getTime() - packageStarted.getTime(),
      status: packages.ready ? 0 : 1,
    },
  ];
  const runPlanPath = path.join(runDirectory, "run-plan.json");
  await writeFile(runPlanPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  let lock;
  try {
    const doctorStarted = new Date();
    const doctor = await collectDoctor({ profile: "desktop", environment });
    const doctorFinished = new Date();
    timings.push({
      phase: "desktop-doctor",
      started_at: doctorStarted.toISOString(),
      finished_at: doctorFinished.toISOString(),
      duration_ms: doctorFinished.getTime() - doctorStarted.getTime(),
      status: doctor.ok ? 0 : 1,
    });
    await writeFile(
      path.join(runDirectory, "doctor.json"),
      `${JSON.stringify(doctor, null, 2)}\n`,
      {
        flag: "wx",
      },
    );
    if (!doctor.ok)
      throw new Error(
        `Desktop doctor needs attention: ${doctorRemediation(doctor) || (doctor.storage.status === "failed" ? doctor.storage.message : undefined)}`,
      );
    if (!packages.ready)
      throw new Error(
        `Workspace package selenium-webdriver is unavailable; remedy ${packages.remediation}`,
      );
    if (!drivers)
      throw new Error(`Desktop drivers are unavailable; remedy ${plan.drivers.remediation}`);

    const prerequisite = await acquireDesktopVerifySession({
      runDirectory,
      environment,
      selection,
      timings,
    });
    lock = prerequisite.lock;

    const phase = (id: string, command: string, args: string[]) =>
      executePhase({ id, command, args, cwd: root, environment, log, timings });
    if (selection.prerequisites.includes("owned-fixture"))
      await phase("scenario-context-preflight", process.execPath, [
        "apps/desktop/scripts/desktop-preparation-test.mts",
        "--context-preflight",
      ]);
    if (plan.qualification_features.includes("qualification-fixtures")) {
      const args = [
        "test",
        "--locked",
        "-p",
        "portcove-core",
        "--lib",
        "--features",
        "qualification-fixtures",
        "qualification_checkpoint::tests",
        "--",
      ];
      const listing = await phase("checkpoint-feature-inventory", "cargo", [
        ...args,
        "--list",
        "--color",
        "never",
      ]);
      const names = checkpointTestNames(listing);
      const output = await phase("checkpoint-feature-tests", "cargo", [
        ...args,
        "--test-threads=1",
        "--color",
        "never",
      ]);
      requireCheckpointTestExecution(names, output);
    }
    const frontendIdentity = await createFrontendBuildIdentity({
      root,
      packageManager: pins.packageManager,
      vitePlusVersion: prerequisite.vitePlusVersion,
      environment,
    });
    await phase("frontend-build", process.execPath, ["apps/desktop/scripts/build-frontend.mts"]);
    if (!paths.frontend_output)
      throw new Error("Desktop verification requires resolved frontend output storage");
    const frontendObservation = await observeFrontendBuild({
      identity: frontendIdentity,
      outputDirectory: paths.frontend_output,
    });
    const frontendTiming = timings.at(-1);
    if (!frontendTiming) throw new Error("Frontend phase timing was not retained");
    frontendTiming.frontend_observation = frontendObservation;
    const desktopFeatures = ["tauri/custom-protocol", ...plan.qualification_features];
    const buildIdentity = ["win32", "linux"].includes(process.platform)
      ? await createVerificationBuildIdentity({
          root,
          frontendIdentity,
          frontendOutputFingerprint: frontendObservation.output_fingerprint,
          features: desktopFeatures,
          cliFeatures: plan.cli_features,
          environment,
        })
      : {
          fingerprint: null,
          inventory_complete: false,
          native_reuse: { reused: false, reason: "outside-windows-linux-verification-extension" },
        };
    await writeFile(
      path.join(runDirectory, "build-identity.json"),
      JSON.stringify(buildIdentity, null, 2),
      { flag: "wx" },
    );
    await phase("desktop-build", "cargo", [
      "build",
      "-p",
      "portcove-desktop",
      "--features",
      desktopFeatures.join(","),
    ]);
    let probe;
    if (selection.prerequisites.includes("owned-fixture")) {
      await phase("cli-build", "cargo", [
        "build",
        "-p",
        "portcove-cli",
        ...(plan.cli_features.length ? ["--features", plan.cli_features.join(",")] : []),
      ]);
      probe = path.join(runDirectory, `portcove-host-tool-fixture${executableSuffix()}`);
      await phase("owned-probe-build", "rustc", [
        "--edition=2024",
        "--crate-name",
        "portcove_host_tool_fixture",
        path.join(root, "crates/portcove-core/src/testdata/host_tool_probe.rs.txt"),
        "-o",
        probe,
      ]);
    }
    const port = await findUnusedDesktopPortPair();
    const metadataPath = path.join(runDirectory, "runner-metadata.json");
    await writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          evidence_input_class: "non-secret-verification-metadata",
          ...(options.acceptanceBindingsFile
            ? {
                acceptance_bindings: readAcceptanceBindings(
                  await readFile(options.acceptanceBindingsFile, "utf8"),
                ),
              }
            : {}),
          profile: selection.profile,
          selected_scenarios: selection.selected_scenarios,
          setup_scenarios: selection.setup_scenarios,
          excluded_scenarios: selection.excluded_scenarios,
          known_gaps: selection.known_gaps,
          restart_cycles: options.restartCycles,
          reload_cycles: options.reloadCycles,
          source_state: source,
          frontend_build: frontendObservation,
          verification_build: {
            build_input_fingerprint: buildIdentity.fingerprint,
            inventory_complete: buildIdentity.inventory_complete,
            native_reuse: buildIdentity.native_reuse,
            compiled_source_revision: source.revision,
          },
          phases: timings,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    const preparationArgs: string[] = [];
    if (probe) {
      if (plan.paths.cli === null) throw new Error("Owned probe requires a planned CLI executable");
      preparationArgs.push("--preparation-cli", plan.paths.cli, "--preparation-tool", probe);
    }
    const harnessArgs = [
      "scripts/desktop-test-cli.mts",
      "--app",
      plan.paths.application,
      "--output",
      path.join(runDirectory, "native"),
      "--driver",
      drivers.driver,
      "--native-driver",
      drivers.nativeDriver,
      "--port",
      String(port),
      "--restart-cycles",
      String(options.restartCycles),
      "--reload-cycles",
      String(options.reloadCycles),
      "--run-metadata",
      metadataPath,
      ...(selection.profile
        ? ["--profile", selection.profile]
        : selection.requested_scenarios.flatMap((id) => ["--scenario", id])),
      ...preparationArgs,
    ];
    const harnessEnvironment = {
      ...environment,
      PORTCOVE_NATIVE_SESSION_LOCK_TOKEN: lock.owner.token,
    };
    await executePhase({
      id: "native-harness",
      command: process.execPath,
      args: harnessArgs,
      cwd: root,
      environment: harnessEnvironment,
      log,
      timings,
    });
    const evidencePath = path.join(runDirectory, "native", "evidence.json");
    const evidence: unknown = JSON.parse(await readFile(evidencePath, "utf8"));
    if (
      !isRecord(evidence) ||
      typeof evidence.outcome !== "string" ||
      !Array.isArray(evidence.checks) ||
      !isRecord(evidence.executable) ||
      typeof evidence.executable.sha256 !== "string"
    )
      throw new Error("Native evidence summary is malformed");
    console.log(
      `desktop-verify: ${evidence.outcome}; ${evidence.checks.length} selected outcomes; ` +
        `executable ${evidence.executable.sha256}; evidence ${evidencePath}`,
    );
  } catch (error) {
    await writeFile(
      path.join(runDirectory, "failure.json"),
      `${JSON.stringify(
        {
          format_version: 1,
          failed_at: new Date().toISOString(),
          message: errorMessage(error),
          phases: timings,
          run_plan: runPlanPath,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    ).catch(() => {});
    console.error(`desktop-verify failed; retained ${runDirectory}`);
    throw error;
  } finally {
    if (lock) await lock.release();
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseDesktopVerifyArgs(args);
  if (options.help) {
    console.log(desktopVerifyUsage);
    return;
  }
  if (options.listScenarios) return printCatalog(options.json, options.operationCoverageInputs);
  const selection = resolveDesktopSelection({
    profile: options.profile,
    scenarios: options.scenarios,
    reloadCycles: options.reloadCycles,
  });
  if (options.plan) return runVerification(options, selection);
  const paths = getPaths();
  return resourceEntrypoint(
    "browser",
    async () => {
      await runVerification(options, selection);
      return 0;
    },
    {
      environment: desktopBuildEnvironment(childEnvironment(paths), selection),
      exclusive: desktopVerificationOutputResources(paths),
    },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main()
    .then((status) => {
      if (typeof status === "number") process.exitCode = status;
    })
    .catch((error) => {
      console.error(`desktop-verify: ${errorMessage(error)}`);
      process.exitCode = 1;
    });
}
