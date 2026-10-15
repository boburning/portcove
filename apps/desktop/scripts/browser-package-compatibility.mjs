import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import semver from "semver";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function assertVitePlusCompatibility(workspace, manifests, bundled) {
  const selected = workspace.catalog?.["vite-plus"];
  if (!semver.valid(selected) || manifests["vite-plus"]?.version !== selected)
    throw new Error("Vite+ proposal requires a frozen install and coordinated migration");
  if (
    workspace.catalog.vite !== `npm:@voidzero-dev/vite-plus-core@${selected}` ||
    manifests.vite?.name !== "@voidzero-dev/vite-plus-core" ||
    manifests.vite.version !== selected ||
    workspace.catalog.vitest !== bundled.vitest ||
    manifests.vitest?.version !== bundled.vitest ||
    workspace.catalog["@vitest/browser-playwright"] !== bundled.vitest ||
    manifests["@vitest/browser-playwright"]?.version !== bundled.vitest ||
    workspace.overrides?.["vite@*"] !== "catalog:" ||
    workspace.overrides?.["vitest@*"] !== "catalog:"
  )
    throw new Error(
      "Vite+ bundle, core alias, Vitest and browser provider require coordinated migration",
    );
}

export function assertBrowserPackageCompatibility(declarations, manifests) {
  for (const name of ["vitest", "@vitest/browser-playwright", "playwright"]) {
    const installed = manifests[name];
    if (
      installed?.name !== name ||
      !semver.valid(installed.version) ||
      !semver.validRange(declarations[name]) ||
      !semver.satisfies(installed.version, declarations[name])
    )
      throw new Error(`Browser package ${name} is missing or differs from its declaration`);
  }
  const provider = manifests["@vitest/browser-playwright"];
  const core = manifests.vitest.version;
  if (!semver.valid(provider.peerDependencies?.vitest) || provider.peerDependencies.vitest !== core)
    throw new Error("Browser provider requires the exact installed Vitest peer");
  if (
    !semver.validRange(provider.peerDependencies?.playwright) ||
    !semver.satisfies(manifests.playwright.version, provider.peerDependencies.playwright)
  )
    throw new Error("Browser provider requires a compatible installed Playwright peer");
  for (const name of ["@vitest/browser", "@vitest/mocker"]) {
    if (
      provider.dependencies?.[name] !== core ||
      manifests[name]?.name !== name ||
      manifests[name].version !== core
    )
      throw new Error(`Browser provider ${name} must match the installed Vitest peer`);
  }
}

export function checkBrowserPackageCompatibility(packageFile) {
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const declarations = { ...read(packageFile).devDependencies };
  const workspaceFile = path.resolve(path.dirname(packageFile), "../../pnpm-workspace.yaml");
  const workspace = parse(readFileSync(workspaceFile, "utf8"));
  for (const [name, version] of Object.entries(declarations))
    if (version === "catalog:") declarations[name] = String(workspace.catalog[name]);
  const require = createRequire(packageFile);
  const repositoryRequire = createRequire(path.join(path.dirname(workspaceFile), "package.json"));
  const providerFile = require.resolve("@vitest/browser-playwright/package.json");
  const providerRequire = createRequire(providerFile);
  const manifests = Object.fromEntries(
    [
      "vite",
      "vitest",
      "@vitest/browser-playwright",
      "playwright",
      "@vitest/browser",
      "@vitest/mocker",
    ].map((name) => [
      name,
      read(
        (name === "@vitest/browser" || name === "@vitest/mocker"
          ? providerRequire
          : require
        ).resolve(`${name}/package.json`),
      ),
    ]),
  );
  manifests["vite-plus"] = read(repositoryRequire.resolve("vite-plus/package.json"));
  const bundled = repositoryRequire("vite-plus/versions").versions;
  assertVitePlusCompatibility(workspace, manifests, bundled);
  assertBrowserPackageCompatibility(declarations, manifests);
  return Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [name, manifest.version]),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const versions = checkBrowserPackageCompatibility(
    fileURLToPath(new URL("../package.json", import.meta.url)),
  );
  console.log(
    `Coordinated Vite+ ${versions["vite-plus"]} / Vitest ${versions.vitest} graph verified`,
  );
}
