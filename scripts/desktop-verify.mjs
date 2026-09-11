#!/usr/bin/env node

import { createRequire } from "node:module";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { collectDoctor } from "./dev-doctor.mjs";
import {
  childEnvironment,
  getPaths,
  minimumFreeGiB,
  preflight,
  spawnCommand,
} from "./dev-storage.mjs";
import {
  catalogReport,
  desktopHarnessDeadlineMs,
  DESKTOP_PROFILES,
  resolveDesktopSelection,
} from "./desktop-scenarios.mjs";
import { acquireNativeSessionLock } from "./native-session-lock.mjs";
import { cachedDesktopDrivers } from "./tool-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));

export const desktopVerifyUsage = `usage: just desktop-verify [--profile PROFILE | --scenario ID ...] [options]

Selection:
  --profile smoke|presentation|restart|artwork|owned-lifecycle|full
  --scenario ID                 Repeat for an exact focused series
  --list-scenarios              List stable IDs and requirements

Options:
  --restart-cycles 1..10        Default: 1
  --reload-cycles 0..25         Default: 0; positive values opt profiles into reload
  --require-clean               Refuse a dirty source tree
  --plan                        Resolve without building or launching
  --json                        Machine output for --plan or --list-scenarios
  --help`;

export function parseDesktopVerifyArgs(args) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", default: false },
      profile: { type: "string" },
      scenario: { type: "string", multiple: true, default: [] },
      "list-scenarios": { type: "boolean", default: false },
      "restart-cycles": { type: "string", default: "1" },
      "reload-cycles": { type: "string", default: "0" },
      "require-clean": { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
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
    restartCycles,
    reloadCycles,
    requireClean: values["require-clean"],
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
      remediation:
        "node scripts/dev-storage.mjs run -- corepack pnpm@11.25.0 --dir apps/desktop install --frozen-lockfile",
    };
  }
}

function executableSuffix(platform = process.platform) {
  return platform === "win32" ? ".exe" : "";
}

export function buildDesktopVerifyPlan({ selection, paths, drivers, source, packages }) {
  const suffix = executableSuffix();
  const ownedFixture = selection.prerequisites.includes("owned-fixture");
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
    source,
    workspace_packages: packages,
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
      "desktop-doctor",
      "workspace-package-preflight",
      "frontend-build",
      "desktop-build",
      ...(ownedFixture ? ["cli-build", "owned-probe-build"] : []),
      "native-harness",
    ],
  };
}

function printCatalog(asJson) {
  const report = { format_version: 1, profiles: DESKTOP_PROFILES, scenarios: catalogReport() };
  if (asJson) return console.log(JSON.stringify(report, null, 2));
  console.log("Native desktop scenarios:");
  for (const item of report.scenarios) {
    const runnable = item.runnable ? "runnable" : `gap: ${item.reason}`;
    console.log(`  ${item.id} — ${item.description}`);
    console.log(
      `    ${runnable}; profiles ${item.profiles.join(", ") || "none"}; prerequisites ${item.prerequisites.join(", ")}`,
    );
  }
}

async function unusedPort(port) {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) =>
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

function doctorRemediation(report) {
  return report.tools
    .filter((tool) => tool.required && tool.status !== "ok")
    .map(
      (tool) => `${tool.id}: ${tool.status}; remedy ${tool.remediation ?? "inspect just doctor"}`,
    )
    .join("; ");
}

async function executePhase({ id, command, args, cwd, environment, log, timings }) {
  const started = new Date();
  console.log(`desktop-verify: ${id}`);
  const result = spawnCommand(command, args, {
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
    duration_ms: finished - started,
    status: result.status ?? 1,
  };
  timings.push(timing);
  await appendFile(
    log,
    `${JSON.stringify({ ...timing, command: [command, ...args] })}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  if (result.status !== 0) throw new Error(`${id} failed with exit code ${result.status}`);
}

async function runVerification(options, selection) {
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
  const plan = buildDesktopVerifyPlan({ selection, paths, drivers, source, packages });
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
    }
    return;
  }

  await mkdir(plan.paths.output_parent, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDirectory = await mkdtemp(path.join(plan.paths.output_parent, `${stamp}-`));
  const log = path.join(runDirectory, "phase.log");
  const timings = [
    {
      phase: "workspace-package-preflight",
      started_at: packageStarted.toISOString(),
      finished_at: packageFinished.toISOString(),
      duration_ms: packageFinished - packageStarted,
      status: packages.ready ? 0 : 1,
    },
  ];
  const runPlanPath = path.join(runDirectory, "run-plan.json");
  await writeFile(runPlanPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  let lock;
  try {
    lock = await acquireNativeSessionLock({
      workspace: root,
      profile: selection.profile,
      scenarios: selection.selected_scenarios,
    });
    const doctorStarted = new Date();
    const doctor = await collectDoctor({ profile: "desktop" });
    const doctorFinished = new Date();
    timings.unshift({
      phase: "desktop-doctor",
      started_at: doctorStarted.toISOString(),
      finished_at: doctorFinished.toISOString(),
      duration_ms: doctorFinished - doctorStarted,
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
        `Desktop doctor needs attention: ${doctorRemediation(doctor) || doctor.storage.message}`,
      );
    if (!packages.ready)
      throw new Error(
        `Workspace package selenium-webdriver is unavailable; remedy ${packages.remediation}`,
      );
    if (!drivers)
      throw new Error(`Desktop drivers are unavailable; remedy ${plan.drivers.remediation}`);

    const environment = childEnvironment(paths);
    const phase = (id, command, args) =>
      executePhase({ id, command, args, cwd: root, environment, log, timings });
    await phase("frontend-build", "pnpm", ["--dir", "apps/desktop", "build"]);
    await phase("desktop-build", "cargo", [
      "build",
      "-p",
      "portcove-desktop",
      "--features",
      "tauri/custom-protocol",
    ]);
    let probe;
    if (selection.prerequisites.includes("owned-fixture")) {
      await phase("cli-build", "cargo", ["build", "-p", "portcove-cli"]);
      probe = path.join(runDirectory, `portcove-host-tool-fixture${executableSuffix()}`);
      await phase("owned-probe-build", "rustc", [
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
          profile: selection.profile,
          selected_scenarios: selection.selected_scenarios,
          setup_scenarios: selection.setup_scenarios,
          excluded_scenarios: selection.excluded_scenarios,
          known_gaps: selection.known_gaps,
          restart_cycles: options.restartCycles,
          reload_cycles: options.reloadCycles,
          source_state: source,
          phases: timings,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    const harnessArgs = [
      "scripts/desktop-test-cli.mjs",
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
      ...(probe ? ["--preparation-cli", plan.paths.cli, "--preparation-tool", probe] : []),
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
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
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
          message: error.message,
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
  if (options.listScenarios) return printCatalog(options.json);
  const selection = resolveDesktopSelection({
    profile: options.profile,
    scenarios: options.scenarios,
    reloadCycles: options.reloadCycles,
  });
  return runVerification(options, selection);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`desktop-verify: ${error.message}`);
    process.exitCode = 1;
  });
}
