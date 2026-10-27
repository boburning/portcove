import { windowsHelperChecksRequired } from "./windows-helper-checks.mts";
import { nodeCaseSelected } from "./node-platform-skips.mts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, isRecord } from "./runtime-values.mts";
import {
  workflowJobs,
  workflowDefinition,
  isQualificationOnlyCondition,
  isReusableQualificationCondition,
  isWindowsHelperExecutionCondition,
} from "./qualification-coverage.mts";
import {
  executableNodeCommands,
  commandTokens,
  parseNodeTestSuites,
  nodeTestPath,
} from "./node-test-suites.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const nodeTest = nodeTestPath;
const inventoryInputs = [
  ".github/workflows/ci.yml",
  "justfile",
  "scripts/run-windows-qualification.ps1",
  "scripts/node-test-suites.json",
];

function qualificationPlatform(runner: unknown) {
  if (typeof runner === "string" && /^ubuntu-(?:latest|\d+\.\d+)$/u.test(runner))
    return "linux-x86_64";
  return runner === "windows-latest"
    ? "windows-x86_64"
    : runner === "macos-26"
      ? "macos-arm64"
      : null;
}

export function requireNodeTestInventory(
  files: readonly string[],
  required: string,
  local: string,
  windowsRunner: string,
  registryText: string,
) {
  if (!files.length) throw new Error("Node test inventory must be nonempty");
  const registry = parseNodeTestSuites(registryText);
  // Native helper ownership is reconciled independently by node-test-suites --check.
  const registered = new Set(
    Object.values(registry.suites)
      .flatMap((suite) => suite.files)
      .filter((file) => nodeTest.test(file)),
  );
  for (const file of registered)
    if (!files.includes(file))
      throw new Error(`Node registry names an absent indexed file: ${file}`);
  const requiredFiles = new Set<string>();
  const localFiles = new Set<string>();
  const qualificationProducers = new Map<
    string,
    { suite: string; arguments: string[]; eligible: boolean; routeEligible: boolean }[]
  >();
  let requiredWindows = false;
  let localWindows = false;
  const wrapper =
    /^(?:\.\/scripts\/run-windows-qualification\.ps1|pwsh -NoLogo -NoProfile -File scripts\/run-windows-qualification\.ps1)$/u;
  const enabled = (condition: unknown) =>
    condition === undefined || condition === true || condition === "true";
  const defaults = (value: unknown) => (isRecord(value) && isRecord(value.run) ? value.run : {});
  const workflowDefaults = defaults(workflowDefinition(required).defaults);
  const straightLine = (body: string) =>
    body.split(/\r?\n/u).every((line) => {
      let command = line.trim();
      if (!command || (command.startsWith("#") && !command.startsWith("#!"))) return true;
      if (wrapper.test(command)) return true;
      // The maintained namespace preflight is one literal, fail-closed command.
      if (
        command ===
        "/usr/bin/unshare --user --map-current-user --mount --pid --fork --mount-proc /usr/bin/true"
      )
        return true;
      // The maintained Just host refusal is a literal child program, not shell control flow.
      if (
        command ===
        `node -e "if (process.platform !== 'win32') { console.error('windows-qualification-check requires Windows'); process.exit(1) }"`
      )
        return true;
      if (command.startsWith("{{storage}} ")) command = command.slice("{{storage}} ".length);
      try {
        const tokens = commandTokens(command);
        return (
          ["node", "pnpm", "cargo"].includes(tokens[0] ?? "") &&
          tokens.every((token) => !/[{}]/u.test(token))
        );
      } catch {
        return false;
      }
    });
  for (const job of Object.values(workflowJobs(required))) {
    if (!Array.isArray(job.steps)) continue;
    const steps: unknown[] = job.steps;
    for (const step of steps) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      // Check generation even in a disabled lane, but never count that lane as coverage.
      const commands = executableNodeCommands(step.run, registry);
      const directory =
        step["working-directory"] ??
        defaults(job.defaults)["working-directory"] ??
        workflowDefaults["working-directory"];
      const shell = step.shell ?? defaults(job.defaults).shell ?? workflowDefaults.shell;
      const executionShape =
        enabled(step.if) &&
        !job["continue-on-error"] &&
        !step["continue-on-error"] &&
        (directory === undefined || directory === "." || directory === "./") &&
        (shell === undefined ||
          (typeof shell === "string" && ["bash", "pwsh", "sh"].includes(shell))) &&
        straightLine(step.run);
      const eligible = executionShape && isQualificationOnlyCondition(job.if);
      const helperLane =
        job["runs-on"] === "windows-latest" && isWindowsHelperExecutionCondition(job.if);
      const routeEligible =
        executionShape && (isReusableQualificationCondition(job.if) || helperLane);
      const disabled = (condition: unknown) => condition === false || condition === "false";
      const otherMode =
        typeof job.if === "string" &&
        /^\s*(?:\$\{\{\s*)?needs\.classify\.outputs\.mode\s*==\s*'(?:fast|prose)'\s*(?:\}\})?\s*$/u.test(
          job.if,
        );
      for (const command of commands)
        for (const file of command.files) {
          if (eligible) requiredFiles.add(file);
          const runner = job["runs-on"];
          const platform = qualificationPlatform(runner);
          // Count potential execution independently from required-owner eligibility.
          // Unsupported conditions, shells or error handling cannot hide a duplicate.
          if (!disabled(job.if) && !disabled(step.if) && !otherMode)
            for (const candidate of platform
              ? [platform]
              : typeof runner === "string" && /^macos-/u.test(runner)
                ? []
                : Object.keys(registry.qualificationOwners?.[file] ?? {})) {
              const key = `${candidate}:${file}`;
              const producers = qualificationProducers.get(key) ?? [];
              producers.push({
                suite: command.id,
                arguments: command.arguments,
                eligible: eligible && candidate === platform,
                routeEligible:
                  routeEligible &&
                  candidate === platform &&
                  (!helperLane ||
                    windowsHelperChecksRequired({
                      mode: "fast",
                      changes: [{ oldPath: file, newPath: file }],
                    })),
              });
              qualificationProducers.set(key, producers);
            }
        }
      if (!eligible) continue;
      if (
        job["runs-on"] === "windows-latest" &&
        step.run.split(/\r?\n/u).some((line) => wrapper.test(line.trim()))
      )
        requiredWindows = true;
    }
  }
  // Only reviewed, explicitly exclusive platform owners opt into deduplication.
  // Other images, prerequisites and complementary filters retain their own routes.
  for (const [file, owners] of Object.entries(registry.qualificationOwners ?? {}))
    for (const [platform, owner] of Object.entries(owners)) {
      const producers = qualificationProducers.get(`${platform}:${file}`) ?? [];
      if (
        producers.length !== 1 ||
        producers[0]?.suite !== owner ||
        !producers[0].eligible ||
        producers[0].arguments.some((arg) => /^--test-(?:name|skip)-pattern(?:=|$)/u.test(arg))
      )
        throw new Error(`Expected one complete ${platform} qualification owner ${owner}: ${file}`);
    }
  // Only normal recipe command bodies are executable consumers. Comments, variables,
  // nested shell branches and documentation cannot register a suite.
  const localLines = local.split(/\r?\n/u);
  const globalContext =
    localLines
      .filter((line) => /^(?:set|import|mod|export|unexport)\b/u.test(line))
      .every(
        (line) => line === 'set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]',
      ) &&
    (!local.includes("{{storage}}") ||
      (localLines.filter((line) => /^storage\s*:=/u.test(line)).length === 1 &&
        localLines.includes('storage := "node scripts/dev-storage.mts run --"')));
  let recipe = false;
  let attributedRecipe = false;
  let body: string[] = [];
  const flush = () => {
    const source = body.join("\n");
    const commands = executableNodeCommands(source, registry);
    if (globalContext && straightLine(source)) {
      for (const command of commands) for (const file of command.files) localFiles.add(file);
      if (body.some((line) => wrapper.test(line.trim()))) localWindows = true;
    }
    body = [];
  };
  for (const line of localLines) {
    if (/^\[/u.test(line)) {
      flush();
      recipe = false;
      attributedRecipe = true;
      continue;
    }
    if (/^[a-z][\w-]*(?:[^:=]*):(?:\s|$)/u.test(line)) {
      flush();
      recipe = !attributedRecipe;
      attributedRecipe = false;
    } else if (/^\S/u.test(line) && !line.startsWith("#")) {
      flush();
      recipe = false;
    }
    if (!recipe || !/^ {4}\S/u.test(line)) continue;
    body.push(line.slice(4));
  }
  flush();
  const windowsCommands = executableNodeCommands(windowsRunner, registry);
  if (windowsCommands.length) {
    // Pin the reviewed mutex/try/finally/exit envelope independently of the registry.
    // A shell control-flow change needs an explicit custody review, not text inference.
    const envelope = windowsRunner
      .replaceAll("\r\n", "\n")
      .replace(/^[ \t]*# node-suite: [a-z][a-z0-9-]*\n/gmu, "")
      .replace(/^([ \t]*)& node --test[^\n]*$/mu, "$1<node-suite-payload>");
    if (
      windowsCommands.length !== 1 ||
      createHash("sha256").update(envelope).digest("hex") !==
        "1360bf2320a0ce5c7d98e24b3a09904871762c0de0655d4559f01ac80d5e9f42"
    )
      throw new Error("Unsupported Windows qualification payload custody");
    for (const command of windowsCommands)
      for (const file of command.files) {
        if (requiredWindows) {
          requiredFiles.add(file);
          const key = `windows-x86_64:${file}`;
          const producers = qualificationProducers.get(key) ?? [];
          producers.push({
            suite: command.id,
            arguments: command.arguments,
            eligible: true,
            routeEligible: true,
          });
          qualificationProducers.set(key, producers);
        }
        if (localWindows) localFiles.add(file);
      }
  }
  for (const [file, routes] of Object.entries(registry.platformSkips ?? {})) {
    if (!registered.has(file)) continue; // Native helper producers have their own registry check.
    for (const route of routes) {
      const platforms = typeof route.platform === "string" ? [route.platform] : route.platform;
      const targets = platforms.map((platform) =>
        platform === "linux"
          ? "linux-x86_64"
          : platform === "win32"
            ? "windows-x86_64"
            : "macos-arm64",
      );
      const selectsRoute = (producer: { arguments: string[]; routeEligible: boolean }) =>
        producer.routeEligible &&
        route.cases.every(
          (name) => nodeCaseSelected(name, producer.arguments, route.suite) === true,
        );
      const complete = targets.flatMap((target) =>
        (qualificationProducers.get(`${target}:${file}`) ?? []).filter(selectsRoute),
      );
      if (!complete.some((producer) => producer.suite === route.owner))
        throw new Error(`Skip route has no complete intended producer ${route.owner}: ${file}`);
      if ((route.category ?? "platform") === "platform")
        for (const target of targets) {
          if (!(qualificationProducers.get(`${target}:${file}`) ?? []).some(selectsRoute))
            throw new Error(`Skip platform route disappeared ${target}: ${file}`);
        }
    }
  }
  for (const file of files) {
    if (!requiredFiles.has(file))
      throw new Error(`${file} is absent from required CI executable suites`);
    if (!localFiles.has(file))
      throw new Error(`${file} is absent from local quality checks executable suites`);
  }
}

export function checkStagedNodeTestInventory(cwd = root) {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Cannot inspect staged Node inventory: ${result.stderr}`);
    return result.stdout;
  };
  const changed = git("diff", "--cached", "--name-only", "--no-renames", "-z")
    .split("\0")
    .filter(Boolean);
  if (!changed.some((file) => nodeTest.test(file) || inventoryInputs.includes(file)))
    return { checked: false, files: 0 };
  if (git("ls-files", "--unmerged", "-z")) throw new Error("Cannot inspect an unmerged index");
  const files = git("ls-files", "-z", "--", "scripts")
    .split("\0")
    .filter((file) => nodeTest.test(file));
  const [workflow = "", recipes = "", runner = "", registry = ""] = inventoryInputs.map((file) =>
    git("show", `:${file}`),
  );
  requireNodeTestInventory(files, workflow, recipes, runner, registry);
  return { checked: true, files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(" ") !== "--staged")
      throw new Error("usage: node scripts/node-test-inventory.mts --staged");
    const result = checkStagedNodeTestInventory();
    if (result.checked)
      console.log(`Node test inventory: ${result.files} indexed files registered`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
