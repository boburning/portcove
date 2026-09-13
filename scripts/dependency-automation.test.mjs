import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFile(path.join(root, name), "utf8");

test("Rust Node and pnpm authorities are exact and workflow consumers do not copy them", async () => {
  const quality = JSON.parse(await read(".github/quality-tools.json"));
  const toolchain = await read("rust-toolchain.toml");
  const cargo = await read("Cargo.toml");
  const node = (await read(".node-version")).trim();
  const desktop = JSON.parse(await read("apps/desktop/package.json"));
  const justfile = await read("justfile");
  assert.equal(toolchain.match(/^channel\s*=\s*"([^"]+)"/mu)?.[1], quality.rust.channel);
  assert.equal(
    cargo.match(/^rust-version\s*=\s*"([^"]+)"/mu)?.[1],
    quality.rust.channel.split(".").slice(0, 2).join("."),
  );
  assert.match(node, /^\d+\.\d+\.\d+$/u);
  assert.match(desktop.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  assert.doesNotMatch(justfile, /\{\{storage\}\}\s+pnpm\b/u);
  assert.match(justfile, /\{\{storage\}\}\s+corepack pnpm\b/u);

  const workflowDirectory = path.join(root, ".github", "workflows");
  const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
  const workflows = await Promise.all(
    workflowNames.map((name) => read(`.github/workflows/${name}`)),
  );
  for (const workflow of workflows) {
    const setupCount = (workflow.match(/uses: pnpm\/action-setup@/g) ?? []).length;
    assert.equal(
      (workflow.match(/package_json_file: apps\/desktop\/package\.json/g) ?? []).length,
      setupCount,
    );
    assert.doesNotMatch(workflow, /uses: pnpm\/action-setup@[\s\S]{0,160}\n\s+version:/u);
  }
});

test("all external GitHub Actions are immutable SHA references", async () => {
  const workflowFiles = [
    ...(await readdir(path.join(root, ".github", "workflows"))).map(
      (name) => `.github/workflows/${name}`,
    ),
    ".github/actions/setup-rust/action.yml",
  ];
  for (const file of workflowFiles) {
    const contents = await read(file);
    for (const [, reference] of contents.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)) {
      if (reference.startsWith("./")) continue;
      assert.match(reference, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/u, file);
    }
  }
});

test("Renovate is the sole conservative routine update authority", async () => {
  const renovate = JSON.parse(await read("renovate.json"));
  assert.equal(renovate.automerge, false);
  assert.equal(renovate.minimumReleaseAge, "3 days");
  assert.equal(renovate.internalChecksFilter, "strict");
  assert.equal(Object.hasOwn(renovate, "prCreation"), false);
  for (const manager of ["cargo", "npm", "github-actions", "rust-toolchain", "custom.regex"])
    assert(renovate.enabledManagers.includes(manager));
  assert(renovate.packageRules.some((rule) => rule.pinDigests === true));
  const managedFiles = renovate.customManagers.flatMap((manager) => manager.managerFilePatterns);
  for (const expected of [
    "quality-tools",
    "node-version",
    "tool-bootstrap",
    "aqua",
    "powershell-resources",
    "release",
  ]) {
    assert(
      managedFiles.some((pattern) => pattern.includes(expected)),
      expected,
    );
  }
  const powershellAnalyzerManager = renovate.customManagers.find((manager) =>
    manager.managerFilePatterns.some((pattern) => pattern.includes("powershell-resources")),
  );
  assert.equal(powershellAnalyzerManager.datasourceTemplate, "nuget");
  assert.equal(
    powershellAnalyzerManager.registryUrlTemplate,
    "https://www.powershellgallery.com/api/v2/",
  );
  assert.equal(powershellAnalyzerManager.versioningTemplate, "nuget");
  await assert.rejects(read(".github/dependabot.yml"), (error) => error.code === "ENOENT");
});

test("Renovate excludes the extracted rusqlite Git dependency identity", async () => {
  const renovate = JSON.parse(await read("renovate.json"));
  const cargo = await read("Cargo.toml");
  const declaration = cargo.match(
    /^rusqlite\s*=\s*\{\s*git\s*=\s*"([^"]+)",\s*rev\s*=\s*"([a-f0-9]{40})"/mu,
  );
  assert(declaration, "workspace rusqlite Git dependency is missing");
  const extraction = {
    manager: "cargo",
    datasource: "git-refs",
    depName: "rusqlite",
    packageName: declaration[1],
    currentDigest: declaration[2],
  };
  assert.equal(extraction.packageName, "https://github.com/rusqlite/rusqlite");

  const matchingRules = renovate.packageRules.filter(
    (rule) =>
      rule.matchManagers?.includes(extraction.manager) &&
      rule.matchDatasources?.includes(extraction.datasource) &&
      rule.matchDepNames?.includes(extraction.depName) &&
      rule.matchPackageNames?.includes(extraction.packageName),
  );
  assert.equal(matchingRules.length, 1);
  assert.equal(matchingRules[0].enabled, false);
});

test("every Renovate custom manager matches its committed authority", async () => {
  const renovate = JSON.parse(await read("renovate.json"));
  const authorities = [
    ".github/quality-tools.json",
    ".node-version",
    ".config/tool-bootstrap.json",
    ".aqua-version",
    "aqua.yaml",
    ".config/powershell-resources.psd1",
    ".github/workflows/release.yml",
  ];

  for (const [index, manager] of renovate.customManagers.entries()) {
    let matched = false;
    for (const authority of authorities) {
      const ownsFile = manager.managerFilePatterns.some((pattern) => {
        assert.match(pattern, /^\/.+\/$/u);
        return new RegExp(pattern.slice(1, -1), "u").test(authority);
      });
      if (!ownsFile) continue;
      const contents = await read(authority);
      if (
        manager.matchStrings.some((pattern) =>
          new RegExp(pattern.replaceAll('\\"', '"'), "u").test(contents),
        )
      ) {
        matched = true;
        break;
      }
    }
    assert(matched, `custom manager ${index} does not match a committed authority`);
  }
});
