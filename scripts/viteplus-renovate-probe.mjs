import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Version-bound inspection, not a replacement Renovate implementation. Upgrade
// this adapter only after checking the installed engine's internal API shape.
export async function probeVitePlusRules(engine, root, output) {
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  assert.equal(read(path.join(engine, "package.json")).version, "44.156.3");
  const mod = (file) => import(pathToFileURL(path.join(engine, "dist", file)));
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
    "oxc-parser",
  ];
  const selected = deps
    .filter((dep) => names.includes(dep.packageName ?? dep.depName) && !dep.skipReason)
    .map((dep) => ({ ...dep, packageName: dep.packageName ?? dep.depName }));
  for (const name of names)
    assert(
      selected.some((dep) => (dep.packageName ?? dep.depName) === name),
      `Missing extracted ${name}`,
    );
  const effective = [];
  for (const dep of selected) {
    const rule = await applyPackageRules({ ...resolved.config, ...dep }, "pre-lookup");
    assert.equal(rule.minimumReleaseAge, "1 day");
    assert.equal(rule.minimumReleaseAgeBehaviour, "timestamp-required");
    assert.equal(rule.internalChecksFilter, "strict");
    assert.equal(rule.automerge, false);
    const name = dep.packageName ?? dep.depName;
    if (name === "vite-plus") {
      assert.equal(rule.enabled, true);
      assert.equal(rule.groupName, "vite-plus");
      assert.deepEqual(rule.schedule, ["at any time"]);
    } else if (
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
    engineSources: Object.fromEntries(
      files.map((file) => [
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
      "Usage: node scripts/viteplus-renovate-probe.mjs <Renovate 44.156.3 package directory> [repository] [output]",
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
