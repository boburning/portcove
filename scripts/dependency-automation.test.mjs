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
  const repositoryPackage = JSON.parse(await read("package.json"));
  const justfile = await read("justfile");
  assert.equal(toolchain.match(/^channel\s*=\s*"([^"]+)"/mu)?.[1], quality.rust.channel);
  assert.equal(
    cargo.match(/^rust-version\s*=\s*"([^"]+)"/mu)?.[1],
    quality.rust.channel.split(".").slice(0, 2).join("."),
  );
  assert.match(node, /^\d+\.\d+\.\d+$/u);
  assert.match(repositoryPackage.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  assert.doesNotMatch(justfile, /\{\{storage\}\}\s+pnpm\b/u);
  assert.doesNotMatch(justfile, /\bcorepack\b/u);
  assert.match(justfile, /node scripts\/run-viteplus\.mjs/u);

  const workflowDirectory = path.join(root, ".github", "workflows");
  const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
  const workflows = await Promise.all(
    workflowNames.map((name) => read(`.github/workflows/${name}`)),
  );
  for (const workflow of workflows) {
    const setupCount = (workflow.match(/uses: pnpm\/action-setup@/g) ?? []).length;
    assert.equal((workflow.match(/package_json_file: package\.json/g) ?? []).length, setupCount);
    assert.doesNotMatch(workflow, /uses: pnpm\/action-setup@[\s\S]{0,160}\n\s+version:/u);
  }
});

test("the root owns the only pnpm workspace lock and repository tool dependencies", async () => {
  const repositoryPackage = JSON.parse(await read("package.json"));
  const desktopPackage = JSON.parse(await read("apps/desktop/package.json"));
  const workspace = await read("pnpm-workspace.yaml");
  const lockfile = await read("pnpm-lock.yaml");

  assert.equal(repositoryPackage.private, true);
  assert.equal(repositoryPackage.type, "module");
  assert.ok(Object.keys(repositoryPackage.devDependencies).length > 0);
  assert.ok(Object.keys(desktopPackage.devDependencies).length > 0);
  assert.deepEqual(Object.keys(repositoryPackage.devDependencies).sort(), [
    "@types/node",
    "fallow",
    "vite-plus",
    "yaml",
  ]);
  assert.deepEqual(
    Object.keys(repositoryPackage.devDependencies).filter((name) =>
      Object.hasOwn(desktopPackage.devDependencies, name),
    ),
    ["vite-plus", "yaml"],
  );
  assert.equal(desktopPackage.devDependencies["vite-plus"], "catalog:");
  assert.equal(desktopPackage.devDependencies.yaml, repositoryPackage.devDependencies.yaml);
  assert.equal(Object.hasOwn(desktopPackage, "packageManager"), false);
  assert.match(workspace, /^packages:\r?\n  - apps\/desktop$/mu);
  assert.match(workspace, /^storeDir: work\/pnpm-store$/mu);
  assert.match(lockfile, /^  apps\/desktop:$/mu);
  assert.match(lockfile, /^    devDependencies:$/mu);
  await assert.rejects(read("apps/desktop/pnpm-lock.yaml"), (error) => error.code === "ENOENT");
  await assert.rejects(
    read("apps/desktop/pnpm-workspace.yaml"),
    (error) => error.code === "ENOENT",
  );

  const workflowDirectory = path.join(root, ".github", "workflows");
  for (const name of (await readdir(workflowDirectory)).filter((entry) => entry.endsWith(".yml"))) {
    const workflow = await read(`.github/workflows/${name}`);
    assert.doesNotMatch(workflow, /cache-dependency-path: apps\/desktop\/pnpm-lock\.yaml/u);
    assert.doesNotMatch(
      workflow,
      /pnpm install --frozen-lockfile\r?\n\s+working-directory: apps\/desktop/u,
    );
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
  assert.equal(renovate.minimumReleaseAge, "1 day");
  assert.equal(renovate.minimumReleaseAgeBehaviour, "timestamp-required");
  assert.equal(renovate.internalChecksFilter, "strict");
  assert.equal(renovate.prConcurrentLimit, 2);
  assert.equal(renovate.branchConcurrentLimit, 2);
  assert.equal(renovate.prHourlyLimit, 0);
  assert.equal(renovate.commitHourlyLimit, 0);
  assert.equal(renovate.rebaseWhen, "conflicted");
  for (const column of ["Package", "Type", "Update", "Change"])
    assert(renovate.prBodyColumns.includes(column), `Required classifier column: ${column}`);
  assert.equal(renovate.prCreation, "immediate");
  assert.equal(renovate.updateNotScheduled, true);
  assert.equal(renovate.timezone, "America/New_York");
  assert.notEqual(renovate.vulnerabilityAlerts?.enabled, false);
  assert.equal(renovate.vulnerabilityAlerts?.prConcurrentLimit, undefined);
  assert.equal(renovate.vulnerabilityAlerts?.branchConcurrentLimit, undefined);
  for (const manager of [
    "cargo",
    "npm",
    "github-actions",
    "rust-toolchain",
    "custom.regex",
    "dockerfile",
  ])
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

test("pnpm prefers one-day releases without turning the preference into a strict install gate", async () => {
  const { parse } = await import("yaml");
  const workspace = parse(await read("pnpm-workspace.yaml"));
  assert.equal(workspace.minimumReleaseAge, 1440);
  assert.equal(workspace.minimumReleaseAgeStrict, false);
  assert.equal(workspace.minimumReleaseAgeExclude, undefined);
  assert.deepEqual(workspace.allowBuilds, { "@swc/core": true });
  const config = JSON.parse(await read("renovate.json"));
  const primary = config.packageRules.find((rule) => rule.groupName === "vite-plus");
  assert.equal(primary.enabled, true);
  assert.deepEqual(primary.matchPackageNames, ["vite-plus"]);
  assert.equal(config.postUpgradeTasks, undefined);
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

test("serde_json lock updates are confined to the authorized Cargo crate identity", async () => {
  const config = JSON.parse(await read("renovate.json"));
  const fixture = JSON.parse(await read("scripts/fixtures/serde-json-renovate-44.156.3.json"));
  const overrides = config.packageRules.filter((rule) => rule.rangeStrategy);
  assert.equal(config.rangeStrategy, "bump");
  assert.equal(overrides.length, 1, "no other dependency range policy is authorized");
  const [rule] = overrides;
  assert.deepEqual(rule, fixture.rule);
  assert.deepEqual(rule.matchManagers, ["cargo"]);
  assert.deepEqual(rule.matchDatasources, ["crate"]);
  assert.deepEqual(rule.matchPackageNames, ["serde_json"]);
  assert.equal(rule.rangeStrategy, "update-lockfile");
  assert.deepEqual(Object.keys(rule).sort(), [
    "description",
    "matchDatasources",
    "matchManagers",
    "matchPackageNames",
    "rangeStrategy",
  ]);
  const identity = { manager: "cargo", datasource: "crate", packageName: "serde_json" };
  const matches = (candidate) =>
    rule.matchManagers.includes(candidate.manager) &&
    rule.matchDatasources.includes(candidate.datasource) &&
    rule.matchPackageNames.includes(candidate.packageName);
  assert.equal(matches(identity), true);
  for (const control of fixture.boundaries.negativeControls) {
    assert.equal(matches({ ...identity, ...control }), false);
    assert.equal(control.rangeStrategy, config.rangeStrategy);
  }
});

test("deployed Cargo replay separates selected lock updates from security and full maintenance", async () => {
  const fixture = JSON.parse(await read("scripts/fixtures/serde-json-renovate-44.156.3.json"));
  const observed = Date.parse(fixture.observedAt);
  const age = 3 * 24 * 60 * 60 * 1000;
  const selected = fixture.lookup.updates[0];
  const serde = fixture.extraction.find((dep) => dep.depName === "serde_json");
  const semver = fixture.extraction.find((dep) => dep.depName === "semver");
  assert.equal(fixture.engine.version, "44.156.3");
  assert.equal(fixture.lookup.updates.length, 1);
  assert.equal(selected.newValue, serde.currentValue);
  assert.equal(selected.isLockfileUpdate, true);
  for (const release of fixture.releases.filter((r) =>
    [selected.newVersion, ...selected.pendingVersions].includes(r.version),
  )) {
    assert.equal(
      observed - Date.parse(release.releaseTimestamp) >= age,
      release.version === selected.newVersion,
    );
  }
  assert.equal(fixture.artifact.locked, selected.newVersion);
  assert.equal(fixture.artifact.nearby, semver.lockedVersion);
  assert.equal(fixture.artifact.manifestUnchanged, true);
  assert.equal(fixture.artifact.otherLockEntriesUnchanged, true);
  assert.deepEqual(fixture.artifact.commands, [
    `cargo update --config net.git-fetch-with-cli=true --manifest-path Cargo.toml --package serde_json@${serde.lockedVersion} --precise ${selected.newVersion}`,
    "cargo update --config net.git-fetch-with-cli=true --manifest-path Cargo.toml --workspace",
  ]);
  const boundaries = fixture.boundaries;
  assert.equal(boundaries.syntheticVersionInputs, true);
  assert.equal(boundaries.compatibleMinor.updateType, "minor");
  assert.equal(boundaries.compatibleMinor.newValue, serde.currentValue);
  assert.equal(boundaries.compatibleMinor.isLockfileUpdate, true);
  assert.equal(boundaries.outOfRangeMajor.approval, true);
  assert.equal(boundaries.outOfRangeMajor.metadata.isLockfileUpdate, undefined);
  assert.equal(boundaries.security.minimumReleaseAge, null);
  assert.equal(boundaries.security.majorApproval, false);
  assert.equal(boundaries.security.automerge, false);
  assert.equal(boundaries.unknownTimestampPending, true);
  assert.equal(boundaries.fullLockfileMaintenance.locked, selected.pendingVersions[0]);
  assert.deepEqual(boundaries.fullLockfileMaintenance.commands, [
    "cargo update --config net.git-fetch-with-cli=true --manifest-path Cargo.toml",
  ]);
  assert.equal(boundaries.fullLockfileMaintenance.universalTransitiveAgeGuarantee, false);
});

test("Renovate admits development tools continuously and suppresses only the Aqua registry authority", async () => {
  const renovate = JSON.parse(await read("renovate.json"));
  const aqua = await read("aqua.yaml");
  const toolingSchedule = ["at any time"];

  const npmCadence = renovate.packageRules.find(
    (rule) =>
      rule.matchManagers?.includes("npm") && rule.matchDepTypes?.includes("devDependencies"),
  );
  assert.deepEqual(npmCadence?.schedule, toolingSchedule);

  const repositoryToolCadence = renovate.packageRules.find(
    (rule) =>
      rule.matchManagers?.includes("custom.regex") &&
      rule.matchPackageNames?.includes("cargo-nextest") &&
      rule.matchPackageNames?.includes("PSScriptAnalyzer"),
  );
  assert.deepEqual(repositoryToolCadence?.schedule, toolingSchedule);

  const aquaPackages = [
    "aquaproj/aqua",
    ...[...aqua.matchAll(/^\s*- name:\s*([^@\s]+)@/gmu)].map((match) => match[1]),
  ];
  assert.deepEqual(aquaPackages, [
    "aquaproj/aqua",
    "astral-sh/ruff",
    "rhysd/actionlint",
    "koalaman/shellcheck",
  ]);
  const aquaGroup = renovate.packageRules.find((rule) => rule.groupName === "aqua-toolchain");
  assert.deepEqual(aquaGroup?.matchManagers, ["custom.regex"]);
  assert.deepEqual(aquaGroup?.matchPackageNames, aquaPackages);
  assert.deepEqual(aquaGroup?.schedule, toolingSchedule);
  assert.notEqual(aquaGroup?.enabled, false);

  const registryManager = renovate.customManagers.find(
    (manager) => manager.depNameTemplate === "aquaproj/aqua-registry",
  );
  assert.equal(registryManager?.datasourceTemplate, "github-tags");
  assert.match(aqua, /registries:\r?\n\s+- type: standard\r?\n\s+ref: v\d+\.\d+\.\d+/u);
  const registryRules = renovate.packageRules.filter(
    (rule) =>
      rule.matchManagers?.includes("custom.regex") &&
      rule.matchDatasources?.includes("github-tags") &&
      rule.matchDepNames?.includes("aquaproj/aqua-registry") &&
      rule.matchPackageNames?.includes("aquaproj/aqua-registry"),
  );
  assert.equal(registryRules.length, 1);
  assert.equal(registryRules[0].enabled, false);

  assert.equal(repositoryToolCadence.matchPackageNames.includes("node"), true);
  assert.equal(
    renovate.packageRules.some(
      (rule) => rule.enabled === false && rule.matchPackageNames?.includes("node"),
    ),
    false,
  );
  assert.notEqual(renovate.vulnerabilityAlerts?.enabled, false);
  // Configuration assertions above own effective schedule, age and alert policy;
  // prose may move between the daily contract and operation reference.
});

test("the RPM prerelease hold excludes only the affected npm CLI version", async () => {
  const config = JSON.parse(await read("renovate.json"));
  const holds = config.packageRules.filter((rule) => rule.allowedVersions);
  const hold = holds.find((rule) => rule.matchPackageNames?.includes("@tauri-apps/cli"));
  assert.ok(hold);
  assert.deepEqual(hold.matchManagers, ["npm"]);
  assert.deepEqual(hold.matchPackageNames, ["@tauri-apps/cli"]);
  assert.equal(hold.allowedVersions, "!/^2\\.12\\.3$/");
  assert.match(hold.description, /#2014/);
  assert.equal(hold.enabled, undefined);
  assert.equal(hold.groupName, undefined);
  const excluded = new RegExp(hold.allowedVersions.slice(2, -1), "u");
  assert.equal(excluded.test("2.12.3"), true);
  for (const version of ["2.12.1", "2.12.2", "2.12.4", "2.12.30", "2.13.0", "3.0.0"]) {
    assert.equal(excluded.test(version), false, version);
  }
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
    "tools/containers/build/Dockerfile",
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

test("compatibility families override inherited groups without coupling unrelated tools", async () => {
  const config = JSON.parse(await read("renovate.json"));
  const expected = {
    react: ["react", "react-dom", "@types/react", "@types/react-dom"],
    tauri: [
      "tauri",
      "tauri-build",
      "tauri-plugin-dialog",
      "tauri-plugin-wdio-webdriver",
      "webview2-com",
      "@tauri-apps/api",
      "@tauri-apps/cli",
      "@tauri-apps/plugin-dialog",
    ],
    tailwind: ["tailwindcss", "@tailwindcss/vite"],
    stylelint: ["stylelint", "stylelint-config-recommended"],
  };
  const matches = (pattern, name) =>
    pattern.startsWith("/") ? new RegExp(pattern.slice(1, -1), "u").test(name) : pattern === name;
  for (const [group, names] of Object.entries(expected)) {
    for (const name of names) {
      // Local packageRules run after the inherited monorepo presets. Exactly one
      // local compatibility rule must own each package; inspect the engine too
      // when qualifying a configuration change, rather than calling this a dry run.
      const rules = config.packageRules.filter(
        (rule) =>
          rule.groupName && rule.matchPackageNames?.some((pattern) => matches(pattern, name)),
      );
      assert.equal(rules.length, 1, `${name} has ambiguous local group ownership`);
      assert.equal(rules[0].groupName, group, name);
    }
  }
  assert.equal(
    config.packageRules.some((rule) => rule.groupName === "frontend-toolchain"),
    false,
  );
  assert.equal(
    config.packageRules.some(
      (rule) => rule.matchPackageNames?.includes("typescript") && rule.groupName,
    ),
    false,
  );
  const desktop = JSON.parse(await read("apps/desktop/package.json"));
  const lock = await read("pnpm-lock.yaml");
  const { parse } = await import("yaml");
  const workspace = parse(await read("pnpm-workspace.yaml"));
  const core = String(workspace.catalog.vitest);
  assert.equal(desktop.devDependencies["@vitest/browser-playwright"], "catalog:");
  assert.equal(String(workspace.catalog["@vitest/browser-playwright"]), core);
  assert.match(
    lock,
    new RegExp(`'@vitest/browser-playwright@${core.replaceAll(".", "\\.")}'`, "u"),
  );
});

test("selective migration intake and security overrides preserve immediate controlled delivery", async () => {
  const config = JSON.parse(await read("renovate.json"));
  assert.equal(config.dependencyDashboardApproval, undefined);
  const migrations = config.packageRules.filter((rule) => rule.dependencyDashboardApproval);
  assert.equal(migrations.length, 1);
  assert.deepEqual(migrations[0].matchUpdateTypes, ["major"]);
  assert.equal(migrations[0].prPriority, -10);
  assert.deepEqual(config.vulnerabilityAlerts, {
    enabled: true,
    automerge: false,
    minimumReleaseAge: null,
    dependencyDashboardApproval: false,
    groupName: null,
    labels: ["dependencies", "security"],
  });
  assert.equal(
    config.schedule,
    undefined,
    "ordinary dependency candidates remain continuously eligible",
  );
  assert.deepEqual(config.lockFileMaintenance.schedule, ["before 6am on monday"]);
  for (const rule of config.packageRules.filter((rule) => rule.schedule))
    assert.deepEqual(rule.schedule, ["at any time"]);
});

test("custom extraction records every exact identity once across supported whitespace and line endings", async () => {
  const config = JSON.parse(await read("renovate.json"));
  const quality = JSON.parse(await read(".github/quality-tools.json"));
  const expected = [
    ...quality.tools.map((tool) => [tool.crate, tool.version]),
    ["rust", quality.rust.channel],
    ["node", (await read(".node-version")).trim()],
    ["tauri-driver", JSON.parse(await read(".config/tool-bootstrap.json")).desktop.tauri_driver],
    ["aquaproj/aqua", (await read(".aqua-version")).trim()],
    ["aquaproj/aqua-registry", (await read("aqua.yaml")).match(/ref:\s*(\S+)/u)[1]],
    ...[...(await read("aqua.yaml")).matchAll(/- name:\s*([^@\s]+)@(\S+)/gu)].map((match) => [
      match[1],
      match[2],
    ]),
    [
      "PSScriptAnalyzer",
      (await read(".config/powershell-resources.psd1")).match(/version\s*=\s*'([^']+)'/u)[1],
    ],
    [
      "anchore/syft",
      (await read(".github/workflows/release.yml")).match(/syft-version:\s*v(\S+)/u)[1],
    ],
  ];
  const files = [
    ".github/quality-tools.json",
    ".node-version",
    ".config/tool-bootstrap.json",
    ".aqua-version",
    "aqua.yaml",
    ".config/powershell-resources.psd1",
    ".github/workflows/release.yml",
  ];
  for (const newline of ["\n", "\r\n"]) {
    const actual = [];
    for (const manager of config.customManagers) {
      for (const file of files) {
        if (
          !manager.managerFilePatterns.some((pattern) =>
            new RegExp(pattern.slice(1, -1), "u").test(file),
          )
        )
          continue;
        const contents = (await read(file)).replace(/\r?\n/gu, newline);
        for (const pattern of manager.matchStrings) {
          for (const match of contents.matchAll(new RegExp(pattern.replaceAll('\\"', '"'), "gu")))
            actual.push([
              manager.depNameTemplate ?? match.groups.depName,
              match.groups.currentValue,
            ]);
        }
      }
    }
    const sort = (values) => values.map((value) => JSON.stringify(value)).sort();
    assert.equal(
      new Set(actual.map((value) => value[0])).size,
      actual.length,
      "duplicate extracted identity",
    );
    assert.deepEqual(sort(actual), sort(expected));
  }
});
