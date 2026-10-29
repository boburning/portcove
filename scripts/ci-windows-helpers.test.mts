import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { workflowJob, executableLines } from "./ci-workflow-fixture.mts";
import { isRecord } from "./runtime-values.mts";
import { parseDocument, stringify } from "yaml";
import { commandTokens, executableNodeCommands, parseNodeTestSuites } from "./node-test-suites.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";

function helperSteps(job: Record<string, unknown>) {
  assert.ok(Array.isArray(job.steps), "Windows helper steps are required");
  const steps: unknown[] = job.steps;
  assert.ok(steps.every(isRecord), "Every helper step is a mapping");
  return steps;
}

function helperCondition(value: unknown) {
  assert.ok(typeof value === "string", "Maintained condition is an expression");
  let expression = value.trim();
  if (expression.startsWith("${{")) {
    assert.ok(expression.endsWith("}}"), "Complete expression wrapper");
    expression = expression.slice(3, -2).trim();
  }
  const tokens: string[] = [];
  const token = /\s+|'(?:[^']|'')*'|[A-Za-z_][A-Za-z_0-9]*|==|!=|&&|\|\||[.()]/guy;
  let cursor = 0;
  while (cursor < expression.length) {
    token.lastIndex = cursor;
    const match = token.exec(expression);
    assert.ok(match, "Maintained condition has only supported expression tokens");
    cursor = token.lastIndex;
    if (!/^\s+$/u.test(match[0])) tokens.push(match[0]);
  }
  // An enclosing expression group changes no operator or string-literal token.
  while (tokens[0] === "(" && tokens.at(-1) === ")") {
    let depth = 0,
      outer = true;
    for (const [index, part] of tokens.entries()) {
      if (part === "(") depth++;
      if (part === ")") depth--;
      if (depth === 0 && index < tokens.length - 1) {
        outer = false;
        break;
      }
    }
    if (!outer || depth !== 0) break;
    tokens.shift();
    tokens.pop();
  }
  return tokens;
}
function requiredHelperFailure(record: Record<string, unknown>) {
  assert.ok(
    record["continue-on-error"] === undefined || record["continue-on-error"] === false,
    "Required helper failure cannot be ignored",
  );
}
function admittedHelperStep(step: Record<string, unknown>, condition = "success()") {
  assert.deepEqual(
    helperCondition(step.if ?? "success()"),
    helperCondition(condition),
    "Required helper step retains its admitted execution condition",
  );
  requiredHelperFailure(step);
}
function effectiveHelperShell(
  step: Record<string, unknown>,
  job: Record<string, unknown>,
  workflow: Record<string, unknown>,
  expected: "pwsh" | "bash",
) {
  const shellDefault = (record: Record<string, unknown>) =>
    isRecord(record.defaults) && isRecord(record.defaults.run)
      ? record.defaults.run.shell
      : undefined;
  const shell =
    step.shell ??
    shellDefault(job) ??
    shellDefault(workflow) ??
    (job["runs-on"] === "windows-latest"
      ? "pwsh"
      : job["runs-on"] === "ubuntu-latest"
        ? "bash"
        : undefined);
  assert.equal(shell, expected, "Required helper body uses its admitted effective shell");
}

function helperArgv(line: string, shell: "pwsh" | "bash" = "pwsh") {
  // The maintained lane uses literal native commands. Unknown shell wrappers are
  // refused rather than interpreted as having no build/install/launch effects.
  assert.match(
    line,
    shell === "pwsh"
      ? /^(?:&\s+)?(?:node(?:\.exe)?|pnpm(?:\.cmd)?)(?:\s|$)/u
      : /^(?:node|pnpm)(?:\s|$)/u,
    "Helper lane permits only maintained literal Node and pnpm commands",
  );
  if (shell === "pwsh")
    assert.doesNotMatch(
      line,
      /''|""/u,
      "PowerShell helper argv excludes unsupported escaped quote encodings",
    );
  let words: string[];
  try {
    words = commandTokens(line.replace(/^&\s+/u, ""));
  } catch {
    assert.fail("Helper lane requires literal argv without substitutions or separators");
  }
  if (words[0] === "node.exe") words[0] = "node";
  if (words[0] === "pnpm.cmd") words[0] = "pnpm";
  return words;
}
function renderHelperArgv(words: string[]) {
  assert.ok(
    words.every((word) => !/["`$\r\n]/u.test(word)),
    "Control argv is literal",
  );
  return words.map((word) => (/\s/u.test(word) ? '"' + word + '"' : word)).join(" ");
}
function helperLineIs(line: string, expected: string[]) {
  // Selection alone grants no credit: the selected step's complete body is
  // checked below, so an unknown prefix, branch or wrapper cannot disappear.
  try {
    return JSON.stringify(helperArgv(line)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
function pinnedHelperLint(step: Record<string, unknown>) {
  assert.ok(typeof step.run === "string");
  admittedHelperStep(step);
  // Bounded maintained PowerShell policy, not a shell interpreter. Capture the
  // private manifest/version bindings; whitespace, literal quoting and names are
  // not pinning authority. The complete body keeps each command reachable.
  const path = String.raw`(?:\.config/powershell-resources\.psd1|'\.config/powershell-resources\.psd1'|"\.config/powershell-resources\.psd1")`;
  const quoted = String.raw`(?:'[^'\r\n]*'|"[^"\x60$\r\n]*")`;
  const code = executableLines(step.run)
    .map((line) =>
      /^(?:&\s+)?node(?:\.exe)?\s+/u.test(line) ? renderHelperArgv(helperArgv(line)) : line,
    )
    .join("\n");
  const pattern = new RegExp(
    String.raw`^\s*(\$[A-Za-z_][\w]*)\s*=\s*Import-PowerShellDataFile\s+-LiteralPath\s+${path}\s+` +
      String.raw`(\$[A-Za-z_][\w]*)\s*=\s*\[string\]\s*\1\.PSScriptAnalyzer\.version\s+` +
      String.raw`if\s*\(\s*-not\s*\(\s*Get-Module\s+-ListAvailable\s+-Name\s+PSScriptAnalyzer\s*\|\s*Where-Object\s+Version\s+-EQ\s+\2\s*\)\s*\)\s*\{\s*` +
      String.raw`Install-PSResource\s+-RequiredResourceFile\s+${path}\s+-Scope\s+CurrentUser\s+-TrustRepository\s*\}\s*` +
      String.raw`Import-Module\s+-Name\s+PSScriptAnalyzer\s+-RequiredVersion\s+\2(?:\s+-Force)?\s+` +
      String.raw`node\s+scripts/run-powershell-lint\.mts\s+` +
      String.raw`if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)\s*\{\s*throw\s+${quoted}\s*\}\s*` +
      String.raw`node\s+scripts/lint-tools.integration\.mts\s+psscriptanalyzer\s+` +
      String.raw`if\s*\(\s*\$LASTEXITCODE\s+-ne\s+0\s*\)\s*\{\s*throw\s+${quoted}\s*\}\s*$`,
    "u",
  );
  assert.match(
    code,
    pattern,
    "Pinned analyzer setup and both checked lint commands remain reachable",
  );
}

function helperRunInventory(
  job: Record<string, unknown>,
  registry: ReturnType<typeof parseNodeTestSuites>,
) {
  const records: { index: number; step: Record<string, unknown>; words: string[] }[] = [];
  const tests: { index: number; command: ReturnType<typeof executableNodeCommands>[number] }[] = [];
  let lintCount = 0;
  for (const [index, step] of helperSteps(job).entries()) {
    if (typeof step.uses === "string")
      assert.doesNotMatch(
        step.uses,
        /(?:^|\/)setup-vp(?:@|$)/u,
        "No broad Desktop bootstrap action",
      );
    if (typeof step.run !== "string") continue;
    const lines = executableLines(step.run);
    if (
      lines.some((line) =>
        helperLineIs(line, ["node", "scripts/lint-tools.integration.mts", "psscriptanalyzer"]),
      )
    ) {
      pinnedHelperLint(step);
      lintCount++;
      continue;
    }
    assert.ok(lines.length, "Maintained helper run has executable commands");
    for (const line of lines) {
      const words = helperArgv(line);
      if (words[0] === "node" && words[1] === "--test") {
        let commands: ReturnType<typeof executableNodeCommands>;
        try {
          commands = executableNodeCommands(renderHelperArgv(words), registry);
        } catch {
          assert.fail("Helper test command must retain its complete registered inventory");
        }
        assert.equal(commands.length, 1, "One actual registered helper invocation per line");
        assert.equal(
          lines.length,
          1,
          "Registered helper invocations are separate failure-propagating steps",
        );
        const command = commands[0];
        assert.ok(command);
        admittedHelperStep(
          step,
          command.id === "native-tools"
            ? "needs.classify.outputs.native_tools == 'true'"
            : undefined,
        );
        tests.push({ index, command });
      } else {
        assert.ok(
          (words[0] === "pnpm" && words[1] === "install") ||
            (words.length === 2 &&
              words[0] === "node" &&
              words[1] === "scripts/native-helper-dependencies.mts"),
          "Helper lane permits only registered tests, dependency observation and fixed import preparation",
        );
        admittedHelperStep(step);
        assert.equal(
          lines.length,
          1,
          "Helper preparation and observation are single reachable commands",
        );
        records.push({ index, step, words });
      }
    }
  }
  return { records, tests, lintCount };
}
function fixedHelperInstall(
  job: Record<string, unknown>,
  registry: ReturnType<typeof parseNodeTestSuites>,
) {
  const inventory = helperRunInventory(job, registry);
  const installs = inventory.records.filter(({ words }) => words[0] === "pnpm");
  assert.equal(installs.length, 1, "One fixed frozen root preparation only");
  const install = installs[0];
  assert.ok(install);
  return { ...inventory, install };
}
function assertOnlyFixedHelperImportPreparation(
  job: Record<string, unknown>,
  registry: ReturnType<typeof parseNodeTestSuites>,
) {
  const { install, tests } = fixedHelperInstall(job, registry);
  const options = new Map<string, string | true>();
  for (let index = 2; index < install.words.length; index++) {
    const word = install.words[index];
    assert.ok(word);
    const name = word.split("=", 1)[0];
    assert.ok(name);
    assert.ok(
      ["--filter", "--frozen-lockfile", "--ignore-scripts"].includes(name),
      "Only fixed preparation options",
    );
    assert.equal(options.has(name), false, "Preparation options occur once");
    if (name === "--filter") {
      const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : install.words[++index];
      assert.equal(value, "portcove-repository", "Preparation remains root-only");
      options.set(name, value);
    } else {
      assert.equal(word, name, "Preparation boolean flags cannot be overridden");
      options.set(name, true);
    }
  }
  assert.equal(options.get("--filter"), "portcove-repository", "Preparation remains root-only");
  assert.equal(options.get("--frozen-lockfile"), true, "Preparation remains frozen");
  assert.equal(options.get("--ignore-scripts"), true, "Preparation disables install scripts");
  const steps = helperSteps(job);
  const setups = steps.flatMap((step, index) =>
    typeof step.uses === "string" && /^pnpm\/action-setup@[a-f0-9]{40}$/u.test(step.uses)
      ? [{ step, index }]
      : [],
  );
  assert.equal(setups.length, 1, "One pinned package manager setup");
  const setup = setups[0];
  assert.ok(
    setup && setup.index < install.index,
    "Pinned package manager setup precedes installation",
  );
  admittedHelperStep(setup.step);
  const setupInputs = setup.step.with ?? {};
  assert.ok(isRecord(setupInputs), "Pinned package manager inputs are a mapping");
  assert.ok(
    setupInputs.run_install === undefined ||
      setupInputs.run_install === false ||
      setupInputs.run_install === "false",
    "Pinned package manager setup cannot add implicit installs",
  );
  assert.equal(
    setupInputs.version,
    undefined,
    "Pinned package manager version comes from the root manifest",
  );
  assert.ok(
    setupInputs.package_json_file === undefined || setupInputs.package_json_file === "package.json",
    "Pinned package manager reads the root manifest",
  );
  const account = tests.find(({ command }) =>
    command.files.includes("scripts/release-local-worker-accounts.test.mts"),
  );
  assert.ok(
    account && account.index > install.index,
    "Root dependencies precede account contracts",
  );
}

void test("helper workflow admits one fixed frozen root import preparation and rejects widened or additional effects", async () => {
  const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const registry = parseNodeTestSuites(
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
  const job = workflowJob("windows_helpers", source);
  const early = readFixtureModuleClosure(
    fileURLToPath(new URL("../", import.meta.url)),
    ["scripts/windows-helper-checks.test.mts"],
    { includeDynamicImports: false },
  );
  assert.deepEqual(
    early.external.filter((dependency) => !isBuiltin(dependency)),
    [],
    "Pre-install helper module retains builtin-only eager imports",
  );
  assertOnlyFixedHelperImportPreparation(job, registry);
  for (const form of [
    "pnpm install --filter portcove-repository --frozen-lockfile --ignore-scripts",
    "pnpm.cmd install --ignore-scripts --filter='portcove-repository' --frozen-lockfile",
    "& pnpm install --frozen-lockfile --filter=portcove-repository --ignore-scripts",
  ]) {
    const equivalent = structuredClone(job);
    const original = fixedHelperInstall(equivalent, registry).install;
    original.step.run = form;
    assertOnlyFixedHelperImportPreparation(equivalent, registry);
    const { install } = fixedHelperInstall(equivalent, registry);
    const withoutFilter = install.words.filter(
      (word, index, words) =>
        word !== "--filter" && words[index - 1] !== "--filter" && !word.startsWith("--filter="),
    );
    for (const [words, message] of [
      [[...withoutFilter, "--filter=*"], /Preparation remains root-only/u],
      [install.words.filter((word) => word !== "--frozen-lockfile"), /Preparation remains frozen/u],
      [
        install.words.filter((word) => word !== "--ignore-scripts"),
        /Preparation disables install scripts/u,
      ],
      [[...install.words, "--offline"], /Only fixed preparation options/u],
    ] as [string[], RegExp][]) {
      const mutant = structuredClone(equivalent);
      const target = fixedHelperInstall(mutant, registry).install;
      target.step.run = renderHelperArgv(words);
      assert.throws(() => assertOnlyFixedHelperImportPreparation(mutant, registry), {
        name: "AssertionError",
        message,
      });
    }
    for (const [inputs, message] of [
      [{ run_install: true }, /cannot add implicit installs/u],
      [{ version: "0.0.0" }, /version comes from the root manifest/u],
      [{ package_json_file: "apps/desktop/package.json" }, /reads the root manifest/u],
    ] as [Record<string, unknown>, RegExp][]) {
      const mutant = structuredClone(equivalent);
      const setup = helperSteps(mutant).find(
        (step) => typeof step.uses === "string" && step.uses.startsWith("pnpm/action-setup@"),
      );
      assert.ok(setup);
      setup.with = { ...(isRecord(setup.with) ? setup.with : {}), ...inputs };
      assert.throws(() => assertOnlyFixedHelperImportPreparation(mutant, registry), {
        name: "AssertionError",
        message,
      });
    }
    for (const added of [
      { run: form },
      { run: "pnpm install" },
      { run: "cargo build" },
      { run: "cargo test" },
      { run: "pnpm exec cargo build" },
      { run: "node bootstrap-Desktop.mts" },
      { run: "desktop-verify.mts" },
      { run: "desktop:build" },
      { run: "native-driver" },
      { uses: "setup-vp" },
    ]) {
      const mutant = structuredClone(equivalent);
      assert.ok(Array.isArray(mutant.steps));
      mutant.steps.push(added);
      assert.throws(() => assertOnlyFixedHelperImportPreparation(mutant, registry), {
        name: "AssertionError",
        message: /Helper lane permits only|One fixed frozen root|No broad Desktop bootstrap/u,
      });
    }
    const escaped = structuredClone(equivalent);
    fixedHelperInstall(escaped, registry).install.step.run =
      "pnpm install --filter='portcove''-repository' --frozen-lockfile --ignore-scripts";
    assert.throws(() => assertOnlyFixedHelperImportPreparation(escaped, registry), {
      name: "AssertionError",
      message: /unsupported escaped quote encodings/u,
    });
    for (const run of [form + " && pnpm install", "exit 0\n" + form]) {
      const mutant = structuredClone(equivalent);
      fixedHelperInstall(mutant, registry).install.step.run = run;
      assert.throws(() => assertOnlyFixedHelperImportPreparation(mutant, registry), {
        name: "AssertionError",
        message: /Helper lane (?:requires literal argv|permits only)/u,
      });
    }
  }
});

function consumingCatalogGate(job: Record<string, unknown>) {
  const consumers = helperSteps(job).filter(
    (step) =>
      typeof step.run === "string" &&
      executableLines(step.run).some((line) =>
        helperLineIs(line, ["node", "scripts/ci-result-gate.mts"]),
      ),
  );
  assert.equal(consumers.length, 1, "One consuming catalog result gate");
  const gate = consumers[0];
  assert.ok(gate && typeof gate.run === "string");
  assert.deepEqual(
    executableLines(gate.run).map((line) => helperArgv(line, "bash")),
    [["node", "scripts/ci-result-gate.mts"]],
    "Catalog gate is one reachable literal invocation without environment overrides",
  );
  admittedHelperStep(gate);
  return gate;
}
function assertWindowsHelperWorkflow(
  source: string,
  registry: ReturnType<typeof parseNodeTestSuites>,
) {
  const workflow: unknown = parseDocument(source).toJS();
  assert.ok(isRecord(workflow));
  const job = workflowJob("windows_helpers", source),
    steps = helperSteps(job);
  requiredHelperFailure(job);
  for (const step of steps)
    if (typeof step.run === "string") effectiveHelperShell(step, job, workflow, "pwsh");
  assert.equal(job["runs-on"], "windows-latest");
  assert.equal(job["timeout-minutes"], 10);
  assert.deepEqual(
    helperCondition(job.if),
    helperCondition("needs.classify.outputs.windows_helpers == 'true'"),
    "Retain Windows helper classifier condition",
  );
  assertOnlyFixedHelperImportPreparation(job, registry);
  const inventory = helperRunInventory(job, registry);
  const native = inventory.tests.filter(({ command }) => command.id === "native-tools");
  assert.equal(native.length, 1, "One executable native-tools invocation");
  assert.deepEqual(native[0]?.command.arguments, [
    "--test",
    "--test-timeout=30000",
    "--test-reporter=./scripts/required-node-test-reporter.mts",
  ]);
  const controls = inventory.tests.filter(({ command }) =>
    command.files.includes("scripts/native-confirmation.test.mts"),
  );
  assert.equal(controls.length, 1, "One actual Windows helper control invocation");
  assert.ok(controls[0]?.command.arguments.includes("--test-concurrency=1"));
  assert.ok(controls[0]?.command.arguments.includes("--test-timeout=30000"));
  assert.equal(
    inventory.records.filter(({ words }) => words[1] === "scripts/native-helper-dependencies.mts")
      .length,
    1,
    "One executable helper dependency observation",
  );
  assert.equal(inventory.lintCount, 1, "One executable pinned analyzer and causal fixture");
  const rust = steps.flatMap((step, index) =>
    step.uses === "./.github/actions/setup-rust" ? [{ step, index }] : [],
  );
  assert.equal(rust.length, 1, "One conditional Rust setup");
  assert.ok(
    rust[0] && native[0] && rust[0].index < native[0].index,
    "Conditional Rust setup precedes native invocation",
  );
  admittedHelperStep(rust[0].step, "needs.classify.outputs.native_tools == 'true'");
  const catalog = workflowJob("catalog", source);
  assert.deepEqual(
    helperCondition(catalog.if),
    helperCondition("always()"),
    "Retain unconditional catalog result aggregation",
  );
  requiredHelperFailure(catalog);
  assert.ok(Array.isArray(catalog.needs));
  const needs: unknown[] = catalog.needs;
  assert.ok(needs.every((value): value is string => typeof value === "string"));
  assert.deepEqual(
    [...needs].sort((left, right) => left.localeCompare(right)),
    ["classify", "prose_checks", "fast_catalog", "windows_helpers", "catalog_full"].sort(
      (left, right) => left.localeCompare(right),
    ),
    "Retain catalog dependency membership",
  );
  const gate = consumingCatalogGate(catalog);
  effectiveHelperShell(gate, catalog, workflow, "bash");
  const environment = {
    ...(isRecord(catalog.env) ? catalog.env : {}),
    ...(isRecord(gate.env) ? gate.env : {}),
  };
  assert.equal(environment.PORTCOVE_GROUP, "catalog");
  assert.ok(typeof environment.PORTCOVE_TARGETED_RESULTS === "string");
  const targeted: unknown = JSON.parse(environment.PORTCOVE_TARGETED_RESULTS);
  assert.deepEqual(
    targeted,
    { windows_helpers: "${{ needs.windows_helpers.result }}" },
    "Consume the actual Windows helper result",
  );
}

void test("workflow runs bounded Windows controls and pinned lint under the existing catalog aggregate", async () => {
  const source = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const registry = parseNodeTestSuites(
    await readFile(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
  const settings: unknown = parseDocument(source).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.jobs));
  const equivalent = structuredClone(settings);
  assert.ok(isRecord(equivalent.jobs));
  const equivalentJobs = Object.fromEntries(Object.entries(equivalent.jobs).reverse());
  equivalent.jobs = equivalentJobs;
  for (const job of Object.values(equivalentJobs))
    if (isRecord(job) && Array.isArray(job.steps)) {
      job.steps = helperSteps(job).map((step) =>
        Object.fromEntries(
          Object.entries({
            ...step,
            name: "cargo build / native-driver / irrelevant label",
          }).reverse(),
        ),
      );
    }
  const catalog = equivalentJobs.catalog,
    helpers = equivalentJobs.windows_helpers;
  assert.ok(isRecord(catalog) && Array.isArray(catalog.needs) && isRecord(helpers));
  catalog.needs.reverse();
  equivalent.defaults = { run: { shell: "bash" } };
  helpers.defaults = { run: { shell: "pwsh" } };
  catalog.if = "${{ ( always ( ) ) }}";
  helpers.if = "${{ needs.classify.outputs.windows_helpers=='true' }}";
  for (const step of helperSteps(helpers)) {
    if (typeof step.if === "string")
      step.if = "${{ ( " + step.if.replaceAll(" == ", "==") + " ) }}";
    else step.if = "${{ success ( ) }}";
  }
  for (const step of helperSteps(helpers))
    if (typeof step.run === "string") {
      step.run = step.run
        .replaceAll("$resources", "$renamedManifest")
        .replaceAll("$requiredVersion", "$renamedAnalyzerVersion")
        .replaceAll("]$renamedManifest", "]  $renamedManifest");
    }
  fixedHelperInstall(helpers, registry).install.step.run =
    "pnpm.cmd install --ignore-scripts --filter='portcove-repository' --frozen-lockfile";
  const inherited = structuredClone(equivalent);
  assert.ok(isRecord(inherited.jobs) && isRecord(inherited.jobs.catalog));
  const inheritedCatalog = inherited.jobs.catalog;
  const inheritedGate = consumingCatalogGate(inheritedCatalog);
  assert.ok(isRecord(inheritedGate.env));
  inheritedCatalog.env = {
    ...(isRecord(inheritedCatalog.env) ? inheritedCatalog.env : {}),
    ...inheritedGate.env,
  };
  delete inheritedGate.env;
  inheritedGate.run = "node 'scripts/ci-result-gate.mts'";
  const baselines = [
    source,
    "# harmless YAML comment\n" +
      stringify(equivalent, {
        collectionStyle: "flow",
        defaultStringType: "QUOTE_DOUBLE",
        lineWidth: 0,
      }),
    stringify(inherited),
  ];
  const changes: { mutate: (jobs: Record<string, unknown>) => void; message: RegExp }[] = [
    {
      mutate: (jobs) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        const step = helperSteps(job).find(
          (step) =>
            typeof step.run === "string" &&
            executableNodeCommands(step.run, registry).some((command) =>
              command.files.includes("scripts/native-confirmation.test.mts"),
            ),
        );
        assert.ok(step && typeof step.run === "string");
        const command = executableLines(step.run)[0];
        assert.ok(command);
        step.run += "\n" + command;
      },
      message: /Registered helper invocations are separate failure-propagating steps/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        job.defaults = { run: { shell: "node {0}" } };
      },
      message: /admitted effective shell/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job));
        consumingCatalogGate(job).shell = "node {0}";
      },
      message: /admitted effective shell/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job));
        consumingCatalogGate(job).run = "& node scripts/ci-result-gate.mts";
      },
      message: /Helper lane permits only maintained literal/u,
    },
    ...["catalog", "windows_helpers"].map((name) => ({
      mutate: (jobs: Record<string, unknown>) => {
        const job = jobs[name];
        assert.ok(isRecord(job));
        job["continue-on-error"] = true;
      },
      message: /Required helper failure cannot be ignored/u,
    })),
    ...[
      "needs.classify.outputs.windows_helpers != 'true'",
      "needs.classify.outputs.windows_helpers == ' true '",
    ].map((condition) => ({
      mutate: (jobs: Record<string, unknown>) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        job.if = condition;
      },
      message: /Retain Windows helper classifier condition/u,
    })),
    {
      mutate: (jobs) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job) && Array.isArray(job.needs));
        job.needs = job.needs.filter((name) => name !== "windows_helpers");
      },
      message: /Retain catalog dependency membership/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job));
        const gate = consumingCatalogGate(job);
        const owner =
          isRecord(gate.env) && Object.hasOwn(gate.env, "PORTCOVE_TARGETED_RESULTS")
            ? gate.env
            : job.env;
        assert.ok(isRecord(owner));
        owner.PORTCOVE_TARGETED_RESULTS = '{"windows_helpers":"${{ needs.fast_catalog.result }}"}';
      },
      message: /Consume the actual Windows helper result/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        const step = helperSteps(job).find((step) => step.uses === "./.github/actions/setup-rust");
        assert.ok(step);
        step.if = "false";
      },
      message: /Required helper step retains its admitted execution condition/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        const step = helperSteps(job).find(
          (step) =>
            typeof step.run === "string" &&
            executableNodeCommands(step.run, registry).some(
              (command) => command.id === "native-tools",
            ),
        );
        assert.ok(step);
        step.run = "# node --test is not executable";
      },
      message: /Maintained helper run has executable commands/u,
    },
    ...["dependency", "account", "lint", "package"].map((role) => ({
      mutate: (jobs: Record<string, unknown>) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        const step = helperSteps(job).find((step) =>
          role === "package"
            ? typeof step.uses === "string" && step.uses.startsWith("pnpm/action-setup@")
            : typeof step.run === "string" &&
              executableLines(step.run).some((line) =>
                role === "dependency"
                  ? helperLineIs(line, ["node", "scripts/native-helper-dependencies.mts"])
                  : role === "lint"
                    ? helperLineIs(line, [
                        "node",
                        "scripts/lint-tools.integration.mts",
                        "psscriptanalyzer",
                      ])
                    : line.includes("scripts/release-local-worker-accounts.test.mts"),
              ),
        );
        assert.ok(step, "Find the consumed " + role + " step before mutation");
        step.if = "false";
      },
      message: /Required helper step retains its admitted execution condition/u,
    })),
    ...["exit 0", '$env:PORTCOVE_TARGETED_RESULTS = "{}"'].map((prefix) => ({
      mutate: (jobs: Record<string, unknown>) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job));
        const gate = consumingCatalogGate(job);
        assert.ok(typeof gate.run === "string");
        gate.run = prefix + "\n" + gate.run;
      },
      message: /Helper lane permits only maintained literal/u,
    })),
    {
      mutate: (jobs) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job));
        consumingCatalogGate(job).if = "false";
      },
      message: /Required helper step retains its admitted execution condition/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.catalog;
        assert.ok(isRecord(job));
        consumingCatalogGate(job)["continue-on-error"] = true;
      },
      message: /Required helper failure cannot be ignored/u,
    },
    {
      mutate: (jobs) => {
        const job = jobs.windows_helpers;
        assert.ok(isRecord(job));
        const lint = helperSteps(job).find(
          (step) =>
            typeof step.run === "string" &&
            executableLines(step.run).some((line) =>
              helperLineIs(line, [
                "node",
                "scripts/lint-tools.integration.mts",
                "psscriptanalyzer",
              ]),
            ),
        );
        assert.ok(lint && typeof lint.run === "string");
        lint.run = lint.run.replace(
          /\[string\]\s*\$[A-Za-z_][\w]*\.PSScriptAnalyzer\.version/u,
          "[string]'0.0.0'",
        );
      },
      message: /Pinned analyzer setup and both checked lint commands remain reachable/u,
    },
  ];
  const shellOverride: unknown = parseDocument(source).toJS();
  assert.ok(isRecord(shellOverride));
  shellOverride.defaults = { run: { shell: "node {0}" } };
  assert.throws(() => assertWindowsHelperWorkflow(stringify(shellOverride), registry), {
    name: "AssertionError",
    message: /admitted effective shell/u,
  });
  for (const baseline of baselines) {
    assertWindowsHelperWorkflow(baseline, registry);
    for (const { mutate, message } of changes) {
      const mutant: unknown = parseDocument(baseline).toJS();
      assert.ok(isRecord(mutant) && isRecord(mutant.jobs));
      mutate(mutant.jobs);
      assert.throws(() => assertWindowsHelperWorkflow(stringify(mutant), registry), {
        name: "AssertionError",
        message,
      });
    }
  }
});
