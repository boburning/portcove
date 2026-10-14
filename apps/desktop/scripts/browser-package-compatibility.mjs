import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import semver from "semver";

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
  const declarations = read(packageFile).devDependencies ?? {};
  const require = createRequire(packageFile);
  const providerFile = require.resolve("@vitest/browser-playwright/package.json");
  const providerRequire = createRequire(providerFile);
  const manifests = Object.fromEntries(
    ["vitest", "@vitest/browser-playwright", "playwright", "@vitest/browser", "@vitest/mocker"].map(
      (name) => [
        name,
        read(
          (name === "@vitest/browser" || name === "@vitest/mocker"
            ? providerRequire
            : require
          ).resolve(`${name}/package.json`),
        ),
      ],
    ),
  );
  assertBrowserPackageCompatibility(declarations, manifests);
  return Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [name, manifest.version]),
  );
}
