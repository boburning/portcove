import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseDocument } from "yaml";
import { isRecord } from "../runtime-values.mts";
import { prerequisiteEnvironment } from "./linux-prerequisites-fixture.mts";

export function compactActionExpression(value: unknown) {
  assert.equal(typeof value, "string");
  return String(value).replace(/'[^']*'|\s+/gu, (token) => (token.startsWith("'") ? token : ""));
}
export function rustAction(source: string) {
  const parsed: unknown = parseDocument(source).toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.runs) && Array.isArray(parsed.runs.steps));
  assert.equal(parsed.runs.using, "composite", "RUST_COMPOSITE_ACTION");
  const steps = parsed.runs.steps.filter(isRecord);
  assert.equal(steps.length, parsed.runs.steps.length);
  const installers = steps.filter(
    (step) => typeof step.uses === "string" && step.uses.startsWith("dtolnay/rust-toolchain@"),
  );
  assert.equal(installers.length, 1, "RUST_INSTALLER_BINDING");
  const installer = installers[0]!;
  assert.match(
    String(installer.uses),
    /^dtolnay\/rust-toolchain@[a-f0-9]{40}$/u,
    "RUST_PINNED_INSTALLER",
  );
  assert.ok(isRecord(installer.with));
  const reference = (value: unknown) => {
    assert.equal(typeof value, "string", "RUST_OUTPUT_REFERENCE");
    const found = String(value).match(/^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/u);
    assert.ok(found, `RUST_OUTPUT_REFERENCE: ${String(value)}`);
    return { step: found[1]!, field: found[2]! };
  };
  const toolchain = reference(installer.with.toolchain),
    components = reference(installer.with.components);
  assert.equal(toolchain.step, components.step, "RUST_COMPONENT_PRODUCER_BINDING");
  const producers = steps.filter((step) => step.id === toolchain.step);
  assert.equal(producers.length, 1, "RUST_CONSUMED_PRODUCER");
  const producer = producers[0]!;
  assert.equal(typeof producer.run, "string");
  const contexts = steps.filter(
    (step) =>
      isRecord(step.env) &&
      Object.values(step.env).some(
        (value) => typeof value === "string" && /github\.sha/u.test(value),
      ) &&
      Object.values(step.env).some(
        (value) => typeof value === "string" && /github\.run_attempt/u.test(value),
      ),
  );
  assert.equal(contexts.length, 1, "RUST_CONTEXT_BINDING");
  const context = contexts[0]!;
  assert.equal(typeof context.run, "string");
  for (const [role, selected] of [
    ["PRODUCER", producer],
    ["INSTALLER", installer],
    ["CONTEXT", context],
  ] as const) {
    assert.equal(selected.if, undefined, `RUST_${role}_REACHABILITY`);
    assert.ok(
      selected["continue-on-error"] === undefined || selected["continue-on-error"] === false,
      `RUST_${role}_FAILURE_PROPAGATION`,
    );
    assert.equal(selected["working-directory"], undefined, `RUST_${role}_WORKING_DIRECTORY`);
  }
  assert.equal(producer.shell, "pwsh", "RUST_PRODUCER_SHELL");
  assert.equal(context.shell, "pwsh", "RUST_CONTEXT_SHELL");
  assert.equal(producer.env, undefined, "RUST_PRODUCER_ENVIRONMENT");
  assert.equal(installer.env, undefined, "RUST_INSTALLER_ENVIRONMENT");
  assert.ok(
    steps.indexOf(producer) < steps.indexOf(installer) &&
      steps.indexOf(installer) < steps.indexOf(context),
    "RUST_ACTION_ORDER",
  );
  return { steps, installer, producer, context, toolchain, components };
}
export function rustTemporaryStorage(action: ReturnType<typeof rustAction>) {
  const selected = action.steps.filter(
    (step) =>
      typeof step.run === "string" &&
      /\$env:GITHUB_ENV/iu.test(step.run) &&
      /TEMP=/u.test(step.run) &&
      /TMP=/u.test(step.run),
  );
  assert.equal(selected.length, 1, "WINDOWS_TEMP_EXPORT_PRODUCER");
  const step = selected[0]!;
  const condition = compactActionExpression(step.if).replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1");
  assert.match(
    condition,
    /^runner\.os=='Windows'&&inputs\.test-fixtures=='true'$/u,
    "WINDOWS_TEMP_FIXTURE_CONDITION",
  );
  return step;
}
export function powerShellAvailable() {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { env: prerequisiteEnvironment(), encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  if (
    process.platform !== "win32" &&
    result.error &&
    "code" in result.error &&
    result.error.code === "ENOENT"
  )
    return false;
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return true;
}
const forbidden = ["rustup", "rustc", "cargo", "node", "Install-Module", "Install-PSResource"]
  .map((name) => `function ${name} { throw 'forbidden-action-command:${name}' }`)
  .join("\n");
function invoke(script: string, cwd: string, environment: NodeJS.ProcessEnv) {
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd,
    env: { ...prerequisiteEnvironment(), ...environment },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}
export function observeToolchainReaders(
  action: ReturnType<typeof rustAction>,
  configs: readonly string[],
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-rust-pin-reader-"));
  try {
    writeFileSync(path.join(root, "producer.ps1"), String(action.producer.run));
    for (const [index, config] of configs.entries())
      writeFileSync(path.join(root, `input-${index}.toml`), config);
    const result = invoke(
      `${forbidden}
$ErrorActionPreference = 'Stop'
for ($index = 0; $index -lt ${configs.length}; $index++) {
  Copy-Item -LiteralPath "input-$index.toml" -Destination rust-toolchain.toml
  $env:GITHUB_OUTPUT = Join-Path (Get-Location) "output-$index.txt"
  [System.IO.File]::WriteAllText($env:GITHUB_OUTPUT, '')
  $accepted = $false
  try { & ./producer.ps1; $accepted = $true } catch { }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) "accepted-$index.txt"), [string]$accepted)
}
`,
      root,
      {},
    );
    assert.equal(result.status, 0, result.stderr);
    return configs.map((_config, index) => {
      const text = readFileSync(path.join(root, `output-${index}.txt`), "utf8");
      const entries =
        text.trim() === ""
          ? []
          : text
              .trim()
              .split(/\r?\n/u)
              .map((line) => {
                const at = line.indexOf("=");
                assert.ok(at > 0);
                return [line.slice(0, at), line.slice(at + 1)] as const;
              });
      assert.equal(new Set(entries.map(([key]) => key)).size, entries.length);
      return {
        accepted: readFileSync(path.join(root, `accepted-${index}.txt`), "utf8") === "True",
        outputs: Object.fromEntries(entries),
        outputText: text,
      };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export function actionEnvironment(
  action: ReturnType<typeof rustAction>,
  outputs: Record<string, string>,
  context: Record<string, string>,
) {
  assert.ok(isRecord(action.context.env));
  return Object.fromEntries(
    Object.entries(action.context.env).map(([key, value]) => {
      assert.match(key, /^[A-Za-z_]\w*$/u);
      assert.equal(typeof value, "string");
      const resolved = String(value).replace(
        /\$\{\{([^}]+)\}\}/gu,
        (_whole, expression: string) => {
          const reference = expression.trim();
          const output = reference.match(/^steps\.([\w-]+)\.outputs\.([\w-]+)$/u);
          if (output) {
            assert.equal(output[1], action.toolchain.step);
            assert.ok(Object.hasOwn(outputs, output[2]!));
            return outputs[output[2]!]!;
          }
          assert.ok(Object.hasOwn(context, reference), `Unsupported action binding: ${reference}`);
          return context[reference]!;
        },
      );
      assert.ok(!resolved.includes("${{"));
      return [key, resolved];
    }),
  );
}
export function observeRustIdentity(
  action: ReturnType<typeof rustAction>,
  environment: Record<string, string>,
  failure: "none" | "rustup" | "rustc" | "cargo" = "none",
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-rust-identity-"));
  try {
    const events = path.join(root, "events.jsonl"),
      summary = path.join(root, "summary.md");
    writeFileSync(events, "");
    writeFileSync(summary, "");
    const stubs = (["rustup", "rustc", "cargo"] as const)
      .map(
        (command, index) => `function ${command} {
  $arguments = @($args | ForEach-Object { [string] $_ })
  Add-Content -LiteralPath $env:FIXTURE_EVENTS -Value (ConvertTo-Json -InputObject @{ command = '${command}'; arguments = $arguments } -Compress)
  $global:LASTEXITCODE = ${command === failure ? 37 + index : 0}
  if ($global:LASTEXITCODE -ne 0) { return }
  ${command === "rustup" ? "'fixture-clippy'; 'fixture-rustfmt'; 'fixture-rust-analyzer'" : command === "rustc" ? "'fixture rustc|version'; 'fixture verbose identity'" : "'fixture Cargo version'"}
}`,
      )
      .join("\n");
    const result = invoke(`${forbidden}\n${stubs}\n${String(action.context.run)}`, root, {
      ...environment,
      FIXTURE_EVENTS: events,
      GITHUB_STEP_SUMMARY: summary,
    });
    const calls = readFileSync(events, "utf8")
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        assert.ok(isRecord(parsed) && typeof parsed.command === "string");
        const observedArguments = parsed.arguments;
        assert.ok(
          Array.isArray(observedArguments) &&
            observedArguments.every((value: unknown): value is string => typeof value === "string"),
        );
        return { command: parsed.command, arguments: observedArguments };
      });
    return { ...result, calls, summary: readFileSync(summary, "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
