import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAqua } from "./tool-cache.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktop = path.join(root, "apps", "desktop");
const nonce = randomUUID();

function run(command, args) {
  const settings = {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  };
  return command === "aqua" ? runAqua(args, settings) : spawnSync(command, args, settings);
}

function runAsync(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function expectSuccess(tool, result) {
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${tool} rejected its valid fixture:\n${result.stdout}${result.stderr}`,
  );
}

function expectFailure(tool, result, diagnostic) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${tool} accepted its invalid fixture`);
  assert.match(
    `${result.stdout}${result.stderr}`,
    diagnostic,
    `${tool} failed without the expected diagnostic`,
  );
}

function expectFixture(tool, valid, invalid) {
  assert.ifError(valid.error);
  assert.equal(
    valid.status,
    0,
    `${tool} rejected its valid fixture:\n${valid.stdout}${valid.stderr}`,
  );
  assert.ifError(invalid.error);
  assert.notEqual(invalid.status, 0, `${tool} accepted its invalid fixture`);
  console.log(`${tool} accepted its valid fixture and rejected its invalid fixture.`);
}

async function oxlintFixture() {
  const directory = path.join(desktop, "src", `.lint-oxlint-${nonce}`);
  const fixture = path.join(directory, "fixture.tsx");
  const moduleFixture = path.join(directory, "module.ts");
  const javascriptFixture = path.join(root, "scripts", `.lint-oxlint-${nonce}.mjs`);
  const viteDirectory = path.join(desktop, `.lint-oxlint-vite-${nonce}`);
  const viteFixture = path.join(viteDirectory, "vite.config.ts");
  const runner = path.join(root, "node_modules", "vite-plus", "bin", "vp");
  let childInvocations = 0;
  function assertFixtureTarget(target) {
    assert.ok(target, "Oxlint fixture child requires an explicit target");
    const absolute = path.resolve(target);
    assert.ok(
      absolute === javascriptFixture ||
        absolute.startsWith(`${directory}${path.sep}`) ||
        absolute.startsWith(`${viteDirectory}${path.sep}`),
      `Oxlint fixture child escaped its isolated targets: ${target}`,
    );
    childInvocations += 1;
  }
  function runOxlint(target) {
    assertFixtureTarget(target);
    return run(process.execPath, [runner, "lint", target]);
  }
  function runOxlintAsync(target) {
    assertFixtureTarget(target);
    return runAsync(process.execPath, [runner, "lint", target]);
  }
  try {
    await mkdir(directory);
    await writeFile(moduleFixture, "export const named = 1;\n");
    await writeFile(
      fixture,
      'import { useState } from "react";\nexport function Fixture() {\n  const [value] = useState(0);\n  void Promise.resolve(value);\n  return <img alt="" src="fixture" />;\n}\n',
    );
    const valid = runOxlint(fixture);
    expectSuccess("Oxlint TypeScript", valid);
    await writeFile(
      fixture,
      'import { expect, it, vi } from "vite-plus/test";\nvi.mock("./module", () => ({ named: 1 }));\nit("accepts contextual messages", () => {\n  expect(1, "fixture context").toBe(1);\n});\n',
    );
    expectSuccess("Oxlint Vitest policy", runOxlint(fixture));
    for (const [source, diagnostic] of [
      ['export const message = "Source profile";', /portcove\(player-copy\)/u],
      ['export const view = <p aria-label="&#86;erified">file(s)</p>;', /portcove\(player-copy\)/u],
      ['export const broken = <p title="broken', /Unterminated|Expected/iu],
      ["let value; let value; export {value};", /already.*declared|redeclar/iu],
    ]) {
      await writeFile(fixture, source);
      expectFailure("Oxlint copy/parser policy", runOxlint(fixture), diagnostic);
    }
    for (const [rule, diagnostic, source] of [
      [
        "floating promises",
        /typescript\(no-floating-promises\)/,
        "export function fixture() {\n  Promise.resolve(1);\n}\n",
      ],
      [
        "unused suppression",
        /unused (?:oxlint-)?disable directive/i,
        "// oxlint-disable-next-line no-undef\nexport const value = 1;\n",
      ],
    ]) {
      await writeFile(fixture, source);
      expectFailure(`Oxlint ${rule}`, runOxlint(fixture), diagnostic);
    }

    await writeFile(javascriptFixture, "export const value = 1;\n");
    expectSuccess("Oxlint JavaScript", runOxlint(javascriptFixture));
    await writeFile(javascriptFixture, "missingPortcoveFunction();\n");
    expectFailure("Oxlint JavaScript", runOxlint(javascriptFixture), /eslint\(no-undef\)/);

    await mkdir(viteDirectory);
    await writeFile(
      path.join(viteDirectory, "tsconfig.json"),
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","noEmit":true,"strict":true},"include":["vite.config.ts"]}\n',
    );
    await writeFile(viteFixture, "export default { server: { port: 5173 } };\n");
    expectSuccess("Oxlint Vite config", runOxlint(viteFixture));
    await writeFile(
      viteFixture,
      "export default function config() {\n  Promise.resolve(1);\n  return {};\n}\n",
    );
    expectFailure(
      "Oxlint type-aware Vite config",
      runOxlint(viteFixture),
      /typescript\(no-floating-promises\)/,
    );

    const hooksOverlap = path.join(directory, "overlap-hooks.tsx");
    const a11yOverlap = path.join(directory, "overlap-a11y.tsx");
    await writeFile(
      hooksOverlap,
      'import { useState } from "react";\nexport function Fixture({ enabled }: { enabled: boolean }) {\n  if (enabled) useState(0);\n  return null;\n}\n',
    );
    await writeFile(
      a11yOverlap,
      'export function Fixture() {\n  return <img src="fixture" />;\n}\n',
    );
    const [hooksResult, a11yResult] = await Promise.all([
      runOxlintAsync(hooksOverlap),
      runOxlintAsync(a11yOverlap),
    ]);
    expectFailure("overlapping Oxlint Hooks fixture", hooksResult, /rules-of-hooks/);
    expectFailure("overlapping Oxlint a11y fixture", a11yResult, /alt-text/);
    await writeFile(
      fixture,
      'export function Fixture() {\n  Promise.resolve(1);\n  return <img src="fixture" />;\n}\n',
    );
    const combined = runOxlint(fixture);
    expectFailure("Oxlint combined standard and typed failures", combined, /alt-text/);
    assert.match(`${combined.stdout}${combined.stderr}`, /typescript\(no-floating-promises\)/);

    console.log("Oxlint overlapping negative fixtures remained independently deterministic.");
    console.log(
      `Oxlint fixture contract executed ${childInvocations} targeted child invocations without a repository-wide scan.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(javascriptFixture, { force: true });
    await rm(viteDirectory, { recursive: true, force: true });
  }
}

async function oxfmtFixture() {
  const fixture = path.join(root, "scripts", `.format-oxfmt-${nonce}.mjs`);
  const command = [
    path.join(root, "node_modules", "vite-plus", "bin", "vp"),
    "fmt",
    "--check",
    fixture,
  ];
  try {
    await writeFile(fixture, "const answer = 42;\nconsole.log(answer);\n");
    const valid = run(process.execPath, command);
    await writeFile(fixture, "const answer={value:42};console.log(answer.value)\n");
    expectFixture("Oxfmt", valid, run(process.execPath, command));
  } finally {
    await rm(fixture, { force: true });
  }
  for (const directory of ["", ".config", "apps/desktop", "crates/portcove-core"]) {
    const toml = path.join(root, directory, `.format-oxfmt-${nonce}.toml`);
    const args = [command[0], "fmt", "--check", toml];
    try {
      await writeFile(toml, '[probe]\nvalue = "owned"\n');
      const valid = run(process.execPath, args);
      await writeFile(toml, '[probe]\nvalue="owned"\n');
      expectFixture("Oxfmt TOML formatting", valid, run(process.execPath, args));
      await writeFile(toml, "[probe\nvalue = [");
      expectFixture("Oxfmt TOML syntax", valid, run(process.execPath, args));
    } finally {
      await rm(toml, { force: true });
    }
  }
  for (const relative of [
    "scripts/.format-oxfmt.generated.json",
    "docs/archive/.format-oxfmt.json",
  ]) {
    const ignored = path.join(root, relative.replace(".format-oxfmt", `.format-oxfmt-${nonce}`));
    try {
      await writeFile(ignored, "{ malformed generated or historical input");
      const result = run(process.execPath, [
        command[0],
        "fmt",
        "--check",
        "--no-error-on-unmatched-pattern",
        ignored,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(ignored, "utf8"), "{ malformed generated or historical input");
    } finally {
      await rm(ignored, { force: true });
    }
  }
}

async function stylelintFixture() {
  const fixture = path.join(desktop, "src", `.lint-style-${nonce}.css`);
  const stylelint = path.join(desktop, "node_modules", "stylelint", "bin", "stylelint.mjs");
  const args = [
    stylelint,
    "--config",
    path.join(desktop, "stylelint.config.mjs"),
    "--max-warnings",
    "0",
    fixture,
  ];
  try {
    await writeFile(fixture, "a { color: var(--color-text); }\n");
    const valid = run(process.execPath, args);
    await writeFile(fixture, "a { not-a-property: red; }\n");
    expectFixture("Stylelint", valid, run(process.execPath, args));
    for (const [label, source] of [
      ["semantic component color", "a { color: #fff; }\n"],
      ["raw primitive color", "a { color: var(--n64-red-500); }\n"],
      [
        "component gradient",
        "a { background: linear-gradient(var(--color-bg),var(--color-bg-elevated)); }\n",
      ],
    ]) {
      await writeFile(fixture, source);
      expectFixture(label, valid, run(process.execPath, args));
    }
  } finally {
    await rm(fixture, { force: true });
  }
}

async function aquaFixture(tool, extension, validSource, invalidSource, arguments_) {
  const fixture = path.join(root, "scripts", `.lint-${tool}-${nonce}.${extension}`);
  const command = ["exec", "--", tool, ...arguments_, fixture];
  try {
    await writeFile(fixture, validSource);
    const valid = run("aqua", command);
    await writeFile(fixture, invalidSource);
    expectFixture(tool, valid, run("aqua", command));
  } finally {
    await rm(fixture, { force: true });
  }
}

async function actionlintFixture() {
  const fixture = path.join(root, "scripts", `.lint-actionlint-${nonce}.yml`);
  const command = [path.join(root, "scripts", "run-actionlint.mjs"), fixture];
  try {
    await writeFile(
      fixture,
      "name: fixture\non:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
    );
    const valid = run(process.execPath, command);
    await writeFile(
      fixture,
      "name: fixture\non:\n  push:\njobs:\n  test:\n    steps:\n      - run: echo invalid\n",
    );
    expectFixture("actionlint", valid, run(process.execPath, command));
  } finally {
    await rm(fixture, { force: true });
  }
}

async function psscriptAnalyzerFixture() {
  if (process.platform !== "win32") {
    console.log("PSScriptAnalyzer fixture is enforced by required Windows CI.");
    return;
  }
  const fixture = path.join(root, "scripts", `.lint-powershell-${nonce}.ps1`);
  const resources = path.join(root, ".config", "powershell-resources.psd1");
  const quote = (value) => value.replaceAll("'", "''");
  const command = `$resources = Import-PowerShellDataFile -LiteralPath '${quote(resources)}'; $version = [string]$resources.PSScriptAnalyzer.version; Import-Module -Name PSScriptAnalyzer -RequiredVersion $version -Force; $findings = @(Invoke-ScriptAnalyzer -Path '${quote(fixture)}' -Severity Warning,Error -ExcludeRule PSUseApprovedVerbs,PSUseShouldProcessForStateChangingFunctions,PSUseSingularNouns); if ($findings.Count) { $findings | Format-Table | Out-String | Write-Error }`;
  try {
    await writeFile(fixture, "param([string]$Name)\nWrite-Output $Name\n");
    const valid = run("pwsh", ["-NoProfile", "-Command", command]);
    await writeFile(fixture, "param([string]$Name)\nInvoke-Expression $Name\n");
    expectFixture("PSScriptAnalyzer", valid, run("pwsh", ["-NoProfile", "-Command", command]));
  } finally {
    await rm(fixture, { force: true });
  }
}

const fixtures = {
  oxfmt: oxfmtFixture,
  oxlint: oxlintFixture,
  stylelint: stylelintFixture,
  ruff: () =>
    aquaFixture("ruff", "py", "name = 'Portcove'\nprint(name)\n", "import os\n", ["check"]),
  shellcheck: () =>
    aquaFixture("shellcheck", "sh", "#!/bin/sh\nprintf '%s\\n' \"$1\"\n", "#!/bin/sh\nif then\n", [
      "--severity=warning",
    ]),
  actionlint: actionlintFixture,
  psscriptanalyzer: psscriptAnalyzerFixture,
};

const selected = process.argv.slice(2);
if (!selected.length || selected.some((name) => !Object.hasOwn(fixtures, name))) {
  throw new Error(`usage: lint-tools.integration.mjs ${Object.keys(fixtures).join("|")} [...]`);
}
for (const name of selected) await fixtures[name]();
