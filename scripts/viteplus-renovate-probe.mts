import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Version-bound inspection, not a replacement Renovate implementation. Upgrade
// this adapter only after checking the installed engine's internal API shape.
export async function probeVitePlusRules(engine: string, root: string, output: string) {
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  assert.equal(read(path.join(engine, "package.json")).version, "44.156.3");
  const mod = (file: string) => import(pathToFileURL(path.join(engine, "dist", file)));
  const { init } = await mod("logger/index.js");
  await init();
  const { GlobalConfig } = await mod("config/global.js");
  GlobalConfig.set({
    localDir: root.replaceAll("\\", "/"),
    cacheDir: path.join(output, "cache").replaceAll("\\", "/"),
    platform: "github",
    allowScripts: false,
  });
  const { resolveConfigPresets } = await mod("config/presets/index.js");
  const { applyPackageRules } = await mod("util/package-rules/index.js");
  const { extractAllPackageFiles } = await mod("modules/manager/npm/extract/index.js");
  const config = read(path.join(root, "renovate.json"));
  const resolved = await resolveConfigPresets(config);
  assert(resolved.config && resolved.visitedPresets);
  const extracted = await extractAllPackageFiles(resolved.config, [
    "package.json",
    "apps/desktop/package.json",
    "pnpm-workspace.yaml",
  ]);
  assert(Array.isArray(extracted));
  const deps = extracted.flatMap((file) =>
    file.deps.map((dep) => ({ ...dep, manager: "npm", packageFile: file.packageFile })),
  );
  const names = [
    "vite-plus",
    "@voidzero-dev/vite-plus-core",
    "vitest",
    "@vitest/browser-playwright",
    "playwright",
  ];
  const selected = deps
    .filter((dep) => names.includes(dep.packageName ?? dep.depName) && !dep.skipReason)
    .map((dep) => ({ ...dep, packageName: dep.packageName ?? dep.depName }));
  for (const name of names)
    assert(
      selected.some((dep) => (dep.packageName ?? dep.depName) === name),
      `Missing extracted ${name}`,
    );
  const { extractPackageFile: extractDockerfile } = await mod(
    "modules/manager/dockerfile/extract.js",
  );
  const dockerfile = "tools/containers/browser/Dockerfile";
  const docker = extractDockerfile(
    readFileSync(path.join(root, dockerfile), "utf8"),
    dockerfile,
    resolved.config,
  );
  const base = docker?.deps.find((dep) => dep.depName === "ghcr.io/voidzero-dev/vite-plus");
  assert(base && !base.skipReason, "Dockerfile extractor must discover the actual base pin");
  assert.equal(
    base.currentValue,
    selected.find((dep) => dep.packageName === "vite-plus").currentValue,
  );
  assert.match(base.currentDigest, /^sha256:[a-f0-9]{64}$/u);
  selected.push({
    ...base,
    packageName: base.packageName ?? base.depName,
    manager: "dockerfile",
    packageFile: dockerfile,
  });
  const builderFile = "tools/containers/build/Dockerfile";
  if (existsSync(path.join(root, builderFile))) {
    const text = readFileSync(path.join(root, builderFile), "utf8");
    const builderDeps = extractDockerfile(text, builderFile, resolved.config)?.deps ?? [];
    for (const name of ["ghcr.io/voidzero-dev/vite-plus", "rust", "ubuntu"]) {
      const dep = builderDeps.find((item) => item.depName === name);
      assert(dep && !dep.skipReason, `Builder extractor omitted ${name}`);
      assert.match(dep.currentDigest, /^sha256:[a-f0-9]{64}$/u);
      if (name === "ubuntu") assert.equal(dep.currentValue, "22.04");
      if (name === "ghcr.io/voidzero-dev/vite-plus")
        assert.equal(dep.currentValue, base.currentValue);
      if (name === "rust")
        assert.equal(
          dep.currentValue,
          `${/channel\s*=\s*"([^"]+)"/u.exec(readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"))[1]}-slim-bookworm`,
        );
      selected.push({
        ...dep,
        packageName: dep.packageName ?? dep.depName,
        manager: "dockerfile",
        packageFile: builderFile,
      });
    }
    const { extractPackageFile: extractRegex } = await mod("modules/manager/custom/regex/index.js");
    const manager = resolved.config.customManagers.find(
      (item) => item.depNameTemplate === "PowerShell/PowerShell",
    );
    assert(manager, "PowerShell update authority missing");
    const powershell = extractRegex(text, builderFile, manager)?.deps;
    assert.equal(powershell?.length, 1);
    assert.equal(powershell[0].currentValue, /^ARG POWERSHELL_VERSION=(.+)$/mu.exec(text)[1]);
    assert.match(text, /^ARG POWERSHELL_SHA256=[a-f0-9]{64}$/mu);
    selected.push({
      ...powershell[0],
      packageName: "PowerShell/PowerShell",
      manager: "custom.regex",
      packageFile: builderFile,
    });
  }
  const effective = [];
  for (const dep of selected) {
    const rule = await applyPackageRules({ ...resolved.config, ...dep }, "pre-lookup");
    assert.equal(rule.minimumReleaseAge, "1 day");
    assert.equal(rule.minimumReleaseAgeBehaviour, "timestamp-required");
    assert.equal(rule.internalChecksFilter, "strict");
    assert.equal(rule.automerge, false);
    const name = dep.packageName ?? dep.depName;
    if (["vite-plus", "ghcr.io/voidzero-dev/vite-plus"].includes(name)) {
      if (name === "vite-plus") assert.equal(rule.enabled, true);
      else assert.notEqual(rule.enabled, false);
      assert.equal(rule.groupName, "vite-plus");
      assert.deepEqual(rule.schedule, ["at any time"]);
      if (dep.manager === "dockerfile") assert.equal(rule.pinDigests, true);
    } else if (name === "rust") assert.equal(rule.groupName, "rust-toolchain");
    else if (
      ["@voidzero-dev/vite-plus-core", "vitest", "@vitest/browser-playwright"].includes(name)
    )
      assert.equal(
        rule.enabled,
        false,
        `Ordinary independent bundle update remains enabled: ${name}`,
      );
    else assert.notEqual(rule.enabled, false);
    // The real vulnerability initializer appends this force rule. Exercise its
    // generated shape with the actual merger rather than reimplementing force.
    const security = await applyPackageRules(
      {
        ...resolved.config,
        ...dep,
        packageRules: [
          ...resolved.config.packageRules,
          {
            matchPackageNames: [name],
            isVulnerabilityAlert: true,
            force: { ...config.vulnerabilityAlerts },
          },
        ],
      },
      "pre-lookup",
    );
    assert.equal(security.enabled, true);
    assert.equal(security.minimumReleaseAge, null);
    assert.equal(security.automerge, false);
    assert.equal(security.groupName, null);
    effective.push({
      depName: dep.depName,
      packageName: name,
      packageFile: dep.packageFile,
      depType: dep.depType,
      currentValue: dep.currentValue,
      lockedVersion: dep.lockedVersion,
      currentDigest: dep.currentDigest,
      manager: dep.manager,
      enabled: rule.enabled ?? true,
      groupName: rule.groupName,
      minimumReleaseAge: rule.minimumReleaseAge,
      minimumReleaseAgeBehaviour: rule.minimumReleaseAgeBehaviour,
      internalChecksFilter: rule.internalChecksFilter,
      security: {
        enabled: security.enabled,
        minimumReleaseAge: security.minimumReleaseAge,
        groupName: security.groupName,
      },
    });
  }
  const files = [
    "modules/manager/npm/extract/index.js",
    "modules/manager/dockerfile/extract.js",
    ...(existsSync(path.join(root, builderFile)) ? ["modules/manager/custom/regex/index.js"] : []),
    "util/package-rules/index.js",
    "workers/repository/init/vulnerability.js",
    "config/utils.js",
  ];
  const report = {
    observedAt: new Date().toISOString(),
    engine: "44.156.3",
    configSha256: createHash("sha256")
      .update(readFileSync(path.join(root, "renovate.json")))
      .digest("hex"),
    declarationSha256: Object.fromEntries(
      [
        "package.json",
        "apps/desktop/package.json",
        "pnpm-workspace.yaml",
        dockerfile,
        ...(existsSync(path.join(root, builderFile)) ? [builderFile, "rust-toolchain.toml"] : []),
      ].map((file: string) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(root, file)))
          .digest("hex"),
      ]),
    ),
    engineSources: Object.fromEntries(
      files.map((file: string) => [
        file,
        createHash("sha256")
          .update(readFileSync(path.join(engine, "dist", file)))
          .digest("hex"),
      ]),
    ),
    presets: resolved.visitedPresets,
    effective,
    hostedObservation: false,
  };
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , engine, root = process.cwd(), output = "work/viteplus-renovate-probe"] = process.argv;
  if (!engine)
    throw new Error(
      "Usage: node scripts/viteplus-renovate-probe.mts <Renovate 44.156.3 package directory> [repository] [output]",
    );
  const report = await probeVitePlusRules(
    path.resolve(engine),
    path.resolve(root),
    path.resolve(output),
  );
  console.log(
    `Verified ${report.effective.length} extracted toolchain/control dependencies; local engine evidence only`,
  );
}
