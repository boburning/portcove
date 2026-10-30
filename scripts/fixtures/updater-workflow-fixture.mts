import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prerequisiteBash, prerequisiteEnvironment } from "./linux-prerequisites-fixture.mts";
import { parseDocument } from "yaml";
import { isRecord } from "../runtime-values.mts";
import { compactActionExpression } from "./rust-action-fixture.mts";

type Fields = Record<string, unknown>;
function record(value: unknown, contract: string): Fields {
  assert.ok(isRecord(value), contract);
  return value;
}
function text(value: unknown, contract: string) {
  assert.equal(typeof value, "string", contract);
  return String(value);
}
function condition(value: unknown) {
  return compactActionExpression(value).replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1");
}
function permissions(value: unknown) {
  const fields = record(value, "UPDATER_READ_ONLY_PERMISSIONS");
  assert.equal(fields.contents, "read", "UPDATER_READ_ONLY_CONTENTS");
  for (const [key, right] of Object.entries(fields))
    assert.ok(
      right === "none" || (key === "contents" && right === "read"),
      "UPDATER_PERMISSION_EXPANSION",
    );
}
function githubExpressions(value: string) {
  const expressions: string[] = [];
  let from = 0;
  while (from < value.length) {
    const start = value.indexOf("${{", from);
    if (start < 0) break;
    let quoted = false,
      end = -1;
    for (let at = start + 3; at < value.length; at++) {
      if (value[at] === "'") {
        if (quoted && value[at + 1] === "'") {
          at++;
          continue;
        }
        quoted = !quoted;
      } else if (!quoted && value[at] === "}" && value[at + 1] === "}") {
        end = at;
        break;
      }
    }
    assert.ok(end >= 0, "UPDATER_GITHUB_EXPRESSION_BOUNDARY");
    expressions.push(value.slice(start + 3, end));
    from = end + 2;
  }
  return expressions;
}
function rejectSecretBindings(value: unknown): void {
  if (typeof value === "string") {
    for (const expression of githubExpressions(value)) {
      const unquoted = expression.replace(/'(?:[^']|'')*'/gu, "''");
      const tokens = unquoted.match(/[A-Za-z_]\w*|\.|[^\s]/gu) ?? [];
      for (const [index, token] of tokens.entries())
        assert.ok(
          token.toLowerCase() !== "secrets" || tokens[index - 1] === ".",
          "UPDATER_PRODUCTION_SECRET_BINDING",
        );
    }
  } else if (Array.isArray(value)) {
    for (const item of value) rejectSecretBindings(item);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === "env" && isRecord(item))
        for (const name of Object.keys(item))
          assert.doesNotMatch(
            name,
            /^TAURI_SIGNING_PRIVATE_KEY(?:_PATH|_PASSWORD)?$/iu,
            "UPDATER_WORKFLOW_SIGNING_AUTHORITY",
          );
      rejectSecretBindings(item);
    }
  }
}
function failurePropagates(step: Fields, role: string) {
  assert.ok(
    step["continue-on-error"] === undefined || step["continue-on-error"] === false,
    `UPDATER_${role}_FAILURE_PROPAGATION`,
  );
  assert.equal(step["working-directory"], undefined, `UPDATER_${role}_WORKING_DIRECTORY`);
}
function operatingSystem(step: Fields, expected: "Linux" | "Windows", role: string) {
  assert.equal(condition(step.if), `runner.os=='${expected}'`, `UPDATER_${role}_PLATFORM`);
  failurePropagates(step, role);
}
export function updaterWorkflow(source: string, offeredLabels: readonly string[]) {
  const document = parseDocument(source, { uniqueKeys: true });
  assert.equal(document.errors.length, 0, "UPDATER_WORKFLOW_YAML");
  const workflow = record(document.toJS(), "UPDATER_WORKFLOW");
  const triggers = record(workflow.on, "UPDATER_MANUAL_TRIGGER");
  assert.deepEqual(Object.keys(triggers), ["workflow_dispatch"], "UPDATER_MANUAL_ONLY");
  assert.equal(workflow.defaults, undefined, "UPDATER_WORKFLOW_DEFAULTS");
  permissions(workflow.permissions);
  rejectSecretBindings(workflow);
  const inputs = record(
    record(triggers.workflow_dispatch, "UPDATER_DISPATCH").inputs,
    "UPDATER_INPUTS",
  );
  const platform = record(inputs.platform, "UPDATER_PLATFORM_INPUT");
  assert.equal(platform.type, "choice");
  assert.equal(platform.default, "all", "UPDATER_COMPLETE_DEFAULT");
  assert.ok(Array.isArray(platform.options));
  assert.deepEqual(
    platform.options.map((value) => text(value, "UPDATER_PLATFORM_LABEL")).toSorted(),
    ["all", ...offeredLabels].toSorted(),
    "UPDATER_OFFERED_PLATFORMS",
  );
  const profile = record(inputs.transition_profile, "UPDATER_PROFILE_INPUT");
  assert.equal(profile.type, "choice");
  assert.equal(profile.default, "legacy-skipped", "UPDATER_PROFILE_DEFAULT");
  assert.deepEqual(
    Array.isArray(profile.options)
      ? profile.options.map((value) => text(value, "UPDATER_PROFILE_LABEL")).toSorted()
      : profile.options,
    ["legacy-adjacent", "legacy-skipped", "preview-final"].toSorted(),
    "UPDATER_PROFILE_OPTIONS",
  );
  const jobs = record(workflow.jobs, "UPDATER_JOBS");
  const owners: { job: Fields; steps: Fields[]; step: Fields; index: number }[] = [];
  for (const value of Object.values(jobs)) {
    const job = record(value, "UPDATER_JOB");
    permissions(job.permissions ?? workflow.permissions);
    assert.equal(job.secrets, undefined, "UPDATER_REUSABLE_SECRET_BINDING");
    if (!Array.isArray(job.steps)) continue;
    const steps = job.steps.map((step) => record(step, "UPDATER_STEP"));
    for (const [index, step] of steps.entries()) {
      if (typeof step.run === "string") {
        const executable = step.run
          .split(/\r?\n/u)
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        assert.doesNotMatch(
          executable,
          /\bgh(?:\.exe)?['"]?\s+['"]?release\b/iu,
          "UPDATER_NO_PUBLICATION",
        );
        if (step.run.replaceAll("\\", "/").includes("scripts/rehearse-updater-artifacts.ps1"))
          owners.push({ job, steps, step, index });
      }
    }
  }
  assert.equal(owners.length, 1, "UPDATER_REHEARSAL_OWNER");
  const owner = owners[0]!;
  assert.equal(owner.job.if, undefined, "UPDATER_JOB_REACHABILITY");
  assert.equal(owner.job.defaults, undefined, "UPDATER_JOB_DEFAULTS");
  failurePropagates(owner.job, "JOB");
  assert.equal(owner.step.if, undefined, "UPDATER_REHEARSAL_REACHABILITY");
  assert.equal(owner.step.shell, "pwsh", "UPDATER_REHEARSAL_SHELL");
  failurePropagates(owner.step, "REHEARSAL");
  const strategy = record(owner.job.strategy, "UPDATER_STRATEGY");
  assert.equal(strategy["fail-fast"], false, "UPDATER_ALL_PRODUCERS_RETAINED");
  const matrix = record(strategy.matrix, "UPDATER_MATRIX");
  assert.equal(Object.keys(matrix).length, 1, "UPDATER_MATRIX_DIMENSIONS");
  const axis = Object.keys(matrix)[0]!;
  const selection = compactActionExpression(matrix[axis]).match(
    /^\$\{\{fromJSON\('([^']+)'\)\[inputs\.platform\|\|'all'\]\}\}$/u,
  );
  assert.ok(selection, "UPDATER_MATRIX_SELECTION");
  const cases = record(JSON.parse(selection[1]!), "UPDATER_MATRIX_CASES");
  assert.deepEqual(
    Object.keys(cases).toSorted(),
    ["all", ...offeredLabels].toSorted(),
    "UPDATER_MATRIX_IDENTITIES",
  );
  assert.ok(Array.isArray(cases.all));
  assert.deepEqual(
    cases.all.map((value) => text(value, "UPDATER_MATRIX_LABEL")).toSorted(),
    offeredLabels.toSorted(),
    "UPDATER_MATRIX_COMPLETE_UNION",
  );
  for (const label of offeredLabels)
    assert.deepEqual(cases[label], [label], "UPDATER_MATRIX_SINGLE_PLATFORM");
  const select = (role: string, predicate: (step: Fields) => boolean) => {
    const rows = owner.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => predicate(step));
    assert.equal(rows.length, 1, `UPDATER_${role}_OWNER`);
    return rows[0]!;
  };
  const upload = select(
    "EVIDENCE",
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@") &&
      isRecord(step.with) &&
      typeof step.with.name === "string" &&
      step.with.name.startsWith("updater-rehearsal-"),
  );
  assert.match(
    text(upload.step.uses, "UPDATER_UPLOAD_ACTION"),
    /^actions\/upload-artifact@[a-f0-9]{40}$/u,
  );
  assert.equal(condition(upload.step.if), "always()", "UPDATER_FAILURE_EVIDENCE");
  failurePropagates(upload.step, "EVIDENCE");
  assert.ok(upload.index > owner.index, "UPDATER_EVIDENCE_AFTER_PRODUCER");
  const uploadInputs = record(upload.step.with, "UPDATER_UPLOAD_INPUTS");
  const artifact = text(uploadInputs.name, "UPDATER_ARTIFACT_IDENTITY").match(
    /^updater-rehearsal-\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/u,
  );
  assert.equal(artifact?.[1], axis, "UPDATER_ARTIFACT_MATRIX_BINDING");
  assert.equal(String(uploadInputs["retention-days"]), "1", "UPDATER_BOUNDED_RETENTION");
  assert.equal(uploadInputs["if-no-files-found"], "error", "UPDATER_MISSING_EVIDENCE_REFUSAL");
  const retainedPaths = text(uploadInputs.path, "UPDATER_EVIDENCE_INPUTS")
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(retainedPaths.length > 0, "UPDATER_EVIDENCE_INPUTS");
  for (const pattern of retainedPaths) {
    assert.ok(!pattern.startsWith("!"), "UPDATER_UNMODELED_EVIDENCE_EXCLUSION");
    assert.doesNotMatch(
      pattern,
      /updater-rehearsal\/\*\*|\.key\b/u,
      "UPDATER_PRIVATE_KEY_RETENTION",
    );
  }
  // These consumed glob families are the maintained retention policy, rather
  // than incidental source spelling or a handful of illustrative filenames.
  for (const family of [
    "work/updater-rehearsal/installer-test/run-*/renderer-qualification/evidence/*.json",
    "work/updater-rehearsal/installer-test/run-*/renderer-qualification/evidence/*.png",
    "work/updater-rehearsal/windows-renderer-evidence/*.json",
    "work/updater-rehearsal/windows-renderer-evidence/*.png",
    "work/updater-rehearsal/qualified-*-bundles/appimage/**",
    "work/updater-rehearsal/qualified-*-bundles/macos/Portcove.app/**",
    "work/updater-rehearsal/macos-installed-selection-qualification/state/*.json",
    "work/updater-rehearsal/linux-appimage-qualification/state/update-state/*.json",
    "work/updater-rehearsal/linux-appimage-qualification/state/library/logs/portcove-desktop.jsonl*",
  ])
    assert.ok(retainedPaths.includes(family), `UPDATER_EVIDENCE_FAMILY: ${family}`);
  for (const pattern of retainedPaths)
    assert.doesNotMatch(
      pattern,
      /renderer-qualification\/\*\*|macos-installed-selection-qualification\/private\/\*\*|linux-appimage-qualification\/(?:private|state)\/\*\*/u,
      "UPDATER_PRIVATE_EVIDENCE_FAMILY",
    );
  const byProgram = (program: string) => (step: Fields) =>
    typeof step.run === "string" && step.run.replaceAll("\\", "/").includes(program);
  const linuxPrerequisite = select(
    "LINUX_PREREQUISITE",
    byProgram("scripts/install-linux-desktop-prerequisites.sh"),
  );
  operatingSystem(linuxPrerequisite.step, "Linux", "LINUX_PREREQUISITE");
  assert.ok(
    linuxPrerequisite.step.shell === undefined || linuxPrerequisite.step.shell === "bash",
    "UPDATER_LINUX_PREREQUISITE_SHELL",
  );
  assert.equal(linuxPrerequisite.step.env, undefined, "UPDATER_LINUX_PREREQUISITE_ENVIRONMENT");
  const linuxDriver = select(
    "LINUX_DRIVER",
    (step) =>
      typeof step.run === "string" &&
      step.run.includes(".config/tool-bootstrap.json") &&
      step.run.includes("tauri_driver"),
  );
  operatingSystem(linuxDriver.step, "Linux", "LINUX_DRIVER");
  assert.ok(
    linuxDriver.step.shell === undefined || linuxDriver.step.shell === "bash",
    "UPDATER_LINUX_DRIVER_SHELL",
  );
  assert.equal(linuxDriver.step.env, undefined, "UPDATER_LINUX_DRIVER_ENVIRONMENT");
  const windowsDriver = select("WINDOWS_DRIVER", byProgram("scripts/bootstrap-quality-tools.ps1"));
  operatingSystem(windowsDriver.step, "Windows", "WINDOWS_DRIVER");
  assert.equal(windowsDriver.step.shell, "pwsh", "UPDATER_WINDOWS_DRIVER_SHELL");
  assert.equal(windowsDriver.step.env, undefined, "UPDATER_WINDOWS_DRIVER_ENVIRONMENT");
  const historicalScope = select("HISTORICAL_SCOPE", (step) => {
    const environment = step.env;
    return (
      isRecord(environment) &&
      ["inputs.historical_linux_bootstrap", "inputs.platform", "inputs.transition_profile"].every(
        (reference) =>
          Object.values(environment).some(
            (value) =>
              typeof value === "string" &&
              compactActionExpression(value) === "${{" + reference + "}}",
          ),
      )
    );
  });
  assert.equal(historicalScope.step.if, undefined, "UPDATER_HISTORICAL_SCOPE_REACHABILITY");
  assert.equal(historicalScope.step.shell, "pwsh", "UPDATER_HISTORICAL_SCOPE_SHELL");
  failurePropagates(historicalScope.step, "HISTORICAL_SCOPE");
  assert.ok(
    owner.steps.every(
      (step, index) =>
        index === historicalScope.index ||
        (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) ||
        historicalScope.index < index,
    ),
    "UPDATER_SCOPE_BEFORE_PREPARATION",
  );
  const runtime = select("WINDOWS_RUNTIME", byProgram("scripts/tool-cache.mts"));
  operatingSystem(runtime.step, "Windows", "WINDOWS_RUNTIME");
  assert.equal(runtime.step.shell, "pwsh", "UPDATER_WINDOWS_RUNTIME_SHELL");
  assert.equal(runtime.step.env, undefined, "UPDATER_WINDOWS_RUNTIME_ENVIRONMENT");
  const verification = select(
    "FIXTURE_VERIFICATION",
    byProgram("scripts/updater-artifact-inventory.test.mts"),
  );
  assert.equal(verification.step.if, undefined, "UPDATER_VERIFICATION_REACHABILITY");
  failurePropagates(verification.step, "VERIFICATION");
  assert.deepEqual(
    verification.step.env,
    { PORTCOVE_REQUIRE_SIGNER_FIXTURE: "1" },
    "UPDATER_MANDATORY_SIGNER_FIXTURE",
  );
  assert.ok(
    windowsDriver.index < runtime.index &&
      runtime.index < verification.index &&
      verification.index < owner.index,
    "UPDATER_RUNTIME_BEFORE_FIXTURES",
  );
  const retainedPathsFor = (label: string) => {
    assert.ok(offeredLabels.includes(label), "UPDATER_RETAINED_PLATFORM");
    return retainedPaths.map((pattern) =>
      pattern.replace(/\$\{\{([^}]+)\}\}/gu, (_whole, expression: string) => {
        assert.equal(
          compactActionExpression("${{" + expression + "}}"),
          "${{matrix." + axis + "}}",
          "UPDATER_RETAINED_MATRIX_BINDING",
        );
        return label;
      }),
    );
  };
  return {
    workflow,
    inputs,
    job: owner.job,
    steps: owner.steps,
    axis,
    rehearsal: owner,
    upload,
    retainedPaths,
    retainedPathsFor,
    linuxPrerequisite,
    historicalScope,
    linuxDriver,
    windowsDriver,
    runtime,
    verification,
  };
}

/** Exercise the same observers after private workflow bindings and mapping order change. */
export function updaterWorkflowVariants(source: string, offeredLabels: readonly string[]) {
  const original = updaterWorkflow(source, offeredLabels);
  const variant = structuredClone(original.workflow);
  const originalJobs = record(original.workflow.jobs, "UPDATER_JOBS");
  const ownerKey = Object.keys(originalJobs).find((key) => originalJobs[key] === original.job);
  assert.ok(ownerKey, "UPDATER_VARIANT_OWNER");
  const jobs = record(variant.jobs, "UPDATER_JOBS");
  const job = record(jobs[ownerKey], "UPDATER_JOB");
  const renamedOwner = "fixture-" + ownerKey;
  assert.ok(!Object.hasOwn(jobs, renamedOwner), "UPDATER_VARIANT_OWNER_COLLISION");
  delete jobs[ownerKey];
  jobs[renamedOwner] = job;
  const matrix = record(record(job.strategy, "UPDATER_STRATEGY").matrix, "UPDATER_MATRIX");
  const renamedAxis =
    original.axis === "selectedPlatform" ? "selectedPlatformFixture" : "selectedPlatform";
  matrix[renamedAxis] = matrix[original.axis];
  delete matrix[original.axis];
  assert.ok(Array.isArray(job.steps), "UPDATER_STEPS");
  const steps = job.steps.map((step) => record(step, "UPDATER_STEP"));
  for (const [index, step] of steps.entries())
    if (step.name !== undefined) step.name = "Description " + String(index);
  for (const role of [original.historicalScope, original.rehearsal]) {
    const step = steps[role.index]!;
    const environment = record(step.env, "UPDATER_CALLER_ENVIRONMENT");
    let run = text(step.run, "UPDATER_CALLER_RUN");
    for (const key of Object.keys(environment)) {
      const renamed = "OBSERVED_" + key;
      assert.ok(!Object.hasOwn(environment, renamed), "UPDATER_VARIANT_ENVIRONMENT_COLLISION");
      environment[renamed] = environment[key];
      delete environment[key];
      run = run.replaceAll("$env:" + key, "$env:" + renamed);
    }
    step.run = run;
  }
  function rewrite(value: unknown): unknown {
    if (typeof value === "string")
      return value.replaceAll("matrix." + original.axis, "matrix." + renamedAxis);
    if (Array.isArray(value)) return value.map(rewrite);
    if (isRecord(value))
      // Mapping declaration order is harmless; executable step order is preserved.
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, child]) => [key, rewrite(child)]),
      );
    return value;
  }
  return [original, updaterWorkflow(JSON.stringify(rewrite(variant)), offeredLabels)];
}

export interface WorkflowCallerCase {
  bindings: Readonly<Record<string, string>>;
}
function resolveRequests(step: Fields, cases: readonly WorkflowCallerCase[]) {
  const resolve = (value: unknown, bindings: Readonly<Record<string, string>>) =>
    text(value, "UPDATER_CALLER_EXPRESSION").replace(
      /\$\{\{([^}]+)\}\}/gu,
      (_whole, expression: string) => {
        const key = expression.trim();
        assert.ok(Object.hasOwn(bindings, key), `UPDATER_CALLER_BINDING: ${key}`);
        const selected = bindings[key]!;
        assert.match(selected, /^[A-Za-z0-9_-]+$/u, "UPDATER_CALLER_LITERAL");
        return selected;
      },
    );
  return cases.map(({ bindings }) => ({
    source: resolve(step.run, bindings),
    environment: Object.fromEntries(
      Object.entries(record(step.env ?? {}, "UPDATER_CALLER_ENVIRONMENT")).map(([key, value]) => {
        assert.match(key, /^[A-Za-z_]\w*$/u, "UPDATER_CALLER_ENVIRONMENT");
        assert.doesNotMatch(
          key,
          /^(?:PATH|HOME|TMP|TEMP|SYSTEMROOT|NODE_OPTIONS|PSMODULEPATH|GITHUB_ENV|GITHUB_OUTPUT|GITHUB_STEP_SUMMARY)$/iu,
          "UPDATER_CALLER_RESERVED_ENVIRONMENT",
        );
        return [key, resolve(value, bindings)];
      }),
    ),
  }));
}
export function observeUpdaterCaller(
  step: Fields,
  program: "rehearse-updater-artifacts.ps1" | "bootstrap-quality-tools.ps1",
  cases: readonly WorkflowCallerCase[],
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-updater-caller-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    const parameters =
      program === "rehearse-updater-artifacts.ps1"
        ? `[CmdletBinding()] param([Parameter(Mandatory=$true)][string]$PlatformLabel,[Parameter(Mandatory=$true)][string]$TransitionProfile,[switch]$HistoricalLinuxBootstrap)
@{ platform=$PlatformLabel; profile=$TransitionProfile; historical=[bool]$HistoricalLinuxBootstrap } | ConvertTo-Json -Compress`
        : `[CmdletBinding()] param([switch]$Desktop)
@{ desktop=[bool]$Desktop } | ConvertTo-Json -Compress`;
    writeFileSync(path.join(root, "scripts", program), parameters);
    const requests = resolveRequests(step, cases);
    writeFileSync(path.join(root, "cases.json"), JSON.stringify(requests));
    const validator = `
$ErrorActionPreference='Stop'
$requests=Get-Content cases.json -Raw | ConvertFrom-Json
$allowedTypes=@('ScriptBlockAst','NamedBlockAst','PipelineAst','CommandAst','CommandParameterAst','StringConstantExpressionAst','ParenExpressionAst','CommandExpressionAst','BinaryExpressionAst','VariableExpressionAst','ConstantExpressionAst')
foreach($request in $requests) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($request.source,[ref]$tokens,[ref]$errors)
  if($errors.Count) { throw 'UPDATER_CALLER_SYNTAX' }
  $commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true))
  if($commands.Count -ne 1) { throw 'UPDATER_CALLER_SINGLE_COMMAND' }
  $command=$commands[0]
  $name=$command.GetCommandName()
  if(-not $name -or $name.Replace('\\','/') -notmatch '^(?:\\./)?scripts/${program.replaceAll(".", "\\.")}$') { throw 'UPDATER_CALLER_PROGRAM' }
  if([string]$command.InvocationOperator -notin @('Unknown','Ampersand')) { throw 'UPDATER_CALLER_INVOCATION' }
  foreach($node in $ast.FindAll({param($node) $true},$true)) {
    if($node.GetType().Name -notin $allowedTypes) { throw "UPDATER_CALLER_AST:$($node.GetType().Name)" }
    if($node -is [Management.Automation.Language.BinaryExpressionAst] -and [string]$node.Operator -ne 'Ceq') { throw 'UPDATER_CALLER_OPERATOR' }
    if($node -is [Management.Automation.Language.VariableExpressionAst]) {
      $variable=$node.VariablePath.UserPath
      if($variable -notin @('true','false') -and (-not $variable.StartsWith('env:') -or $variable.Substring(4) -cnotin @($request.environment.PSObject.Properties.Name))) { throw 'UPDATER_CALLER_VARIABLE' }
    }
  }
  foreach($entry in $request.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name,[string]$entry.Value,'Process') }
  try { & $ast.GetScriptBlock() }
  finally { foreach($entry in $request.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name,$null,'Process') } }
}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", validator], {
      cwd: root,
      env: prerequisiteEnvironment(),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `UPDATER_CALLER_OBSERVATION: ${result.stderr}`);
    const rows = result.stdout
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => record(JSON.parse(line), "UPDATER_CALLER_RECEIPT"));
    assert.equal(rows.length, cases.length, "UPDATER_CALLER_RECEIPT_COUNT");
    return rows;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function shellQuote(value: string) {
  return "'" + value.replaceAll("\\", "/").replaceAll("'", "'\"'\"'") + "'";
}
export function observeLinuxDriver(step: Fields, bootstrap: string) {
  const source = text(step.run, "UPDATER_LINUX_DRIVER_RUN");
  const lines = source
    .replace(/\\\r?\n[\t ]*/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.equal(lines.length, 2, "UPDATER_LINUX_DRIVER_COMMANDS");
  const lookup = lines[0]!.match(
    /^([A-Za-z_]\w*)=\$\(\s*(?:node|"node"|'node')\s+(?:-p|"-p"|'-p')\s+(["'])([\s\S]*)\2\s*\)$/u,
  );
  assert.ok(lookup, "UPDATER_LINUX_DRIVER_LOOKUP");
  assert.doesNotMatch(lookup[3]!, /[$`;|&<>\r\n]/u, "UPDATER_LINUX_DRIVER_LOOKUP_EFFECTS");
  assert.match(
    lines[1]!,
    /^(?:cargo|"cargo"|'cargo')\s+[A-Za-z0-9_$ {}"'.-]+$/u,
    "UPDATER_LINUX_DRIVER_INSTALL",
  );
  const variables = [...lines[1]!.matchAll(/\$(?:\{(\w+)\}|(\w+))/gu)];
  assert.equal(variables.length, 1, "UPDATER_LINUX_DRIVER_VERSION_BINDING");
  for (const variable of variables)
    assert.equal(variable[1] ?? variable[2], lookup[1], "UPDATER_LINUX_DRIVER_VERSION_BINDING");
  assert.ok(
    !lines[1]!.replace(/\$(?:\{\w+\}|\w+)/gu, "").includes("$"),
    "UPDATER_LINUX_DRIVER_LITERAL",
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-updater-driver-"));
  try {
    mkdirSync(path.join(root, ".config"));
    writeFileSync(path.join(root, ".config/tool-bootstrap.json"), bootstrap);
    const observer = path.join(root, "lookup.mjs"),
      output = path.join(root, "cargo-arguments");
    writeFileSync(
      observer,
      `import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
assert.equal(process.argv.length,4,'UPDATER_PIN_LOOKUP_ARGUMENTS');assert.equal(process.argv[2],'-p','UPDATER_PIN_LOOKUP_MODE');
const expression=process.argv[3].replace(/'[^']*'|"[^"]*"|\\s+/gu,token=>token.startsWith("'")||token.startsWith('"')?token:'');
assert.match(expression,/^require\\((['"])\\.\\/\\.config\\/tool-bootstrap\\.json\\1\\)\\.desktop\\.tauri_driver$/u,'UPDATER_PIN_LOOKUP');
const result=spawnSync(process.execPath,['-p',process.argv[3]],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:10000});
assert.ifError(result.error);assert.equal(result.status,0,result.stderr);process.stdout.write(result.stdout);
`,
    );
    const program = `set -euo pipefail
node() { ${shellQuote(process.execPath)} ${shellQuote(observer)} "$@"; }
cargo() { printf '%s\\0' "$@" > ${shellQuote(output)}; }
${source}`;
    const result = spawnSync(prerequisiteBash(), ["--noprofile", "--norc", "-c", program], {
      cwd: root,
      env: prerequisiteEnvironment(),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `UPDATER_LINUX_DRIVER_OBSERVATION: ${result.stderr}`);
    const bytes = readFileSync(output, "utf8");
    assert.ok(bytes.endsWith("\0"), "UPDATER_LINUX_DRIVER_RECEIPT");
    return bytes.slice(0, -1).split("\0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function observeHistoricalScope(step: Fields, cases: readonly WorkflowCallerCase[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-updater-scope-"));
  try {
    writeFileSync(path.join(root, "cases.json"), JSON.stringify(resolveRequests(step, cases)));
    const script = `
$ErrorActionPreference='Stop'
$requests=Get-Content cases.json -Raw | ConvertFrom-Json
$allowedTypes=@('ScriptBlockAst','NamedBlockAst','IfStatementAst','StatementBlockAst','PipelineAst','CommandExpressionAst','BinaryExpressionAst','ParenExpressionAst','VariableExpressionAst','StringConstantExpressionAst','ThrowStatementAst','ConstantExpressionAst')
foreach($request in $requests) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($request.source,[ref]$tokens,[ref]$errors)
  if($errors.Count) { throw 'UPDATER_SCOPE_SYNTAX' }
  foreach($node in $ast.FindAll({param($node) $true},$true)) {
    if($node.GetType().Name -notin $allowedTypes) { throw "UPDATER_SCOPE_AST:$($node.GetType().Name)" }
    if($node -is [Management.Automation.Language.BinaryExpressionAst] -and [string]$node.Operator -notin @('Ceq','Cne','And','Or')) { throw 'UPDATER_SCOPE_OPERATOR' }
    if($node -is [Management.Automation.Language.VariableExpressionAst]) {
      $variable=$node.VariablePath.UserPath
      if(-not $variable.StartsWith('env:') -or $variable.Substring(4) -cnotin @($request.environment.PSObject.Properties.Name)) { throw 'UPDATER_SCOPE_VARIABLE' }
    }
  }
  foreach($entry in $request.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name,[string]$entry.Value,'Process') }
  $admitted=$false
  try { & $ast.GetScriptBlock(); $admitted=$true }
  catch { if($_.Exception -isnot [Management.Automation.RuntimeException]) { throw } }
  finally { foreach($entry in $request.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($entry.Name,$null,'Process') } }
  @{admitted=$admitted} | ConvertTo-Json -Compress
}
`;
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: root,
      env: prerequisiteEnvironment(),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `UPDATER_SCOPE_OBSERVATION: ${result.stderr}`);
    const rows = result.stdout
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => record(JSON.parse(line), "UPDATER_SCOPE_RECEIPT"));
    assert.equal(rows.length, cases.length, "UPDATER_SCOPE_RECEIPT_COUNT");
    return rows;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
