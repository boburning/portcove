import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const desktop = path.join(root, "apps", "desktop");
const nonce = randomUUID();

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
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
  console.log(
    `${tool} accepted its valid fixture and rejected its invalid fixture.`,
  );
}

async function eslintFixture() {
  const directory = path.join(root, "scripts", `.lint-eslint-${nonce}`);
  const fixture = path.join(directory, "fixture.mjs");
  try {
    await mkdir(directory);
    await writeFile(fixture, "const answer = 42;\nconsole.log(answer);\n");
    const valid = run(process.execPath, [
      path.join(root, "scripts", "run-eslint.mjs"),
      fixture,
    ]);
    await writeFile(fixture, "missingName();\n");
    expectFixture(
      "ESLint",
      valid,
      run(process.execPath, [
        path.join(root, "scripts", "run-eslint.mjs"),
        fixture,
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function stylelintFixture() {
  const fixture = path.join(desktop, "src", `.lint-style-${nonce}.css`);
  const stylelint = path.join(
    desktop,
    "node_modules",
    "stylelint",
    "bin",
    "stylelint.mjs",
  );
  const args = [
    stylelint,
    "--config",
    path.join(desktop, "stylelint.config.mjs"),
    "--max-warnings",
    "0",
    fixture,
  ];
  try {
    await writeFile(fixture, "a { color: #fff; }\n");
    const valid = run(process.execPath, args);
    await writeFile(fixture, "a { not-a-property: red; }\n");
    expectFixture("Stylelint", valid, run(process.execPath, args));
  } finally {
    await rm(fixture, { force: true });
  }
}

async function aquaFixture(
  tool,
  extension,
  validSource,
  invalidSource,
  arguments_,
) {
  const fixture = path.join(
    root,
    "scripts",
    `.lint-${tool}-${nonce}.${extension}`,
  );
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
    expectFixture(
      "PSScriptAnalyzer",
      valid,
      run("pwsh", ["-NoProfile", "-Command", command]),
    );
  } finally {
    await rm(fixture, { force: true });
  }
}

const fixtures = {
  eslint: eslintFixture,
  stylelint: stylelintFixture,
  ruff: () =>
    aquaFixture(
      "ruff",
      "py",
      "name = 'Portcove'\nprint(name)\n",
      "import os\n",
      ["check"],
    ),
  shellcheck: () =>
    aquaFixture(
      "shellcheck",
      "sh",
      "#!/bin/sh\nprintf '%s\\n' \"$1\"\n",
      "#!/bin/sh\nif then\n",
      ["--severity=warning"],
    ),
  actionlint: actionlintFixture,
  psscriptanalyzer: psscriptAnalyzerFixture,
};

const selected = process.argv.slice(2);
if (
  !selected.length ||
  selected.some((name) => !Object.hasOwn(fixtures, name))
) {
  throw new Error(
    `usage: lint-tools.integration.mjs ${Object.keys(fixtures).join("|")} [...]`,
  );
}
for (const name of selected) await fixtures[name]();
