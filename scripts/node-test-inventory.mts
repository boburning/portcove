import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { workflowJobs, workflowDefinition } from "./qualification-coverage.mts";
import { annotatedNodeCommands, parseNodeTestSuites, nodeTestPath } from "./node-test-suites.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const nodeTest = nodeTestPath;
const inventoryInputs = [
  ".github/workflows/ci.yml",
  "justfile",
  "scripts/run-windows-qualification.ps1",
  "scripts/node-test-suites.json",
];

export function requireNodeTestInventory(
  files: readonly string[],
  required: string,
  local: string,
  windowsRunner: string,
  registryText: string,
) {
  if (!files.length) throw new Error("Node test inventory must be nonempty");
  const registry = parseNodeTestSuites(registryText);
  const registered = new Set(Object.values(registry.suites).flatMap((suite) => suite.files));
  for (const file of registered)
    if (!files.includes(file))
      throw new Error(`Node registry names an absent indexed file: ${file}`);
  const requiredFiles = new Set<string>();
  const localFiles = new Set<string>();
  let requiredWindows = false;
  let localWindows = false;
  const wrapper =
    /^(?:\.\/scripts\/run-windows-qualification\.ps1|pwsh -NoLogo -NoProfile -File scripts\/run-windows-qualification\.ps1)$/u;
  const enabled = (condition: unknown) =>
    condition === undefined || condition === true || condition === "true";
  const defaults = (value: unknown) => (isRecord(value) && isRecord(value.run) ? value.run : {});
  const workflowDefaults = defaults(workflowDefinition(required).defaults);
  const straightLine = (body: string) =>
    !body
      .split(/\r?\n/u)
      .some((line) =>
        /^\s*(?:if\b|elif\b|else\b|fi\b|for\b|while\b|case\b|function\b|exit\b|return\b|#!)/u.test(
          line,
        ),
      );
  for (const job of Object.values(workflowJobs(required))) {
    if (!Array.isArray(job.steps)) continue;
    const steps: unknown[] = job.steps;
    for (const step of steps) {
      if (!isRecord(step) || typeof step.run !== "string") continue;
      // Check generation even in a disabled lane, but never count that lane as coverage.
      const commands = annotatedNodeCommands(step.run, registry);
      const directory =
        step["working-directory"] ??
        defaults(job.defaults)["working-directory"] ??
        workflowDefaults["working-directory"];
      const shell = step.shell ?? defaults(job.defaults).shell ?? workflowDefaults.shell;
      if (
        typeof job.if !== "string" ||
        job.if.trim() !== "needs.classify.outputs.mode == 'qualification'" ||
        !enabled(step.if) ||
        Boolean(job["continue-on-error"]) ||
        Boolean(step["continue-on-error"]) ||
        (directory !== undefined && directory !== "." && directory !== "./") ||
        (shell !== undefined &&
          (typeof shell !== "string" || !["bash", "pwsh", "sh"].includes(shell))) ||
        !straightLine(step.run)
      )
        continue;
      for (const command of commands) for (const file of command.files) requiredFiles.add(file);
      if (
        job["runs-on"] === "windows-latest" &&
        step.run.split(/\r?\n/u).some((line) => wrapper.test(line.trim()))
      )
        requiredWindows = true;
    }
  }
  // Only normal recipe command bodies are executable consumers. Comments, variables,
  // nested shell branches and documentation cannot register a suite.
  let recipe = false;
  let body: string[] = [];
  const flush = () => {
    const source = body.join("\n");
    const commands = annotatedNodeCommands(source, registry);
    if (straightLine(source)) {
      for (const command of commands) for (const file of command.files) localFiles.add(file);
      if (body.some((line) => wrapper.test(line.trim()))) localWindows = true;
    }
    body = [];
  };
  for (const line of local.split(/\r?\n/u)) {
    if (/^[a-z][\w-]*(?:[^:=]*):(?:\s|$)/u.test(line)) {
      flush();
      recipe = true;
    } else if (/^\S/u.test(line) && !line.startsWith("#")) {
      flush();
      recipe = false;
    }
    if (!recipe || !/^ {4}\S/u.test(line)) continue;
    body.push(line.slice(4));
  }
  flush();
  const windowsCommands = annotatedNodeCommands(windowsRunner, registry);
  if (windowsCommands.length) {
    // Pin the reviewed mutex/try/finally/exit envelope independently of the registry.
    // A shell control-flow change needs an explicit custody review, not text inference.
    const envelope = windowsRunner
      .replaceAll("\r\n", "\n")
      .replace(
        /^([ \t]*)# node-suite: [a-z][a-z0-9-]*\n\1& node --test[^\n]*$/mu,
        "$1<node-suite-payload>",
      );
    if (
      windowsCommands.length !== 1 ||
      createHash("sha256").update(envelope).digest("hex") !==
        "1360bf2320a0ce5c7d98e24b3a09904871762c0de0655d4559f01ac80d5e9f42"
    )
      throw new Error("Unsupported Windows qualification payload custody");
    for (const command of windowsCommands)
      for (const file of command.files) {
        if (requiredWindows) requiredFiles.add(file);
        if (localWindows) localFiles.add(file);
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
