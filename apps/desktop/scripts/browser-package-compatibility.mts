import { workspacePackageDeclaration } from "../../../scripts/workspace-package-declaration.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import semver from "semver";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import path from "node:path";

function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Package metadata requires a text version");
  return value;
}
function validVersion(value: unknown): value is string {
  return typeof value === "string" && semver.valid(value) !== null;
}
function validRange(value: unknown): value is string {
  return typeof value === "string" && semver.validRange(value) !== null;
}
export function assertVitePlusCompatibility(
  workspaceValue: unknown,
  manifestValues: unknown,
  bundledValue: unknown,
) {
  const workspace = object(workspaceValue);
  const catalog = object(workspace.catalog);
  const overrides = object(workspace.overrides);
  const manifests = object(manifestValues);
  const bundled = object(bundledValue);
  const selected = catalog["vite-plus"];
  if (!validVersion(selected) || object(manifests["vite-plus"]).version !== selected)
    throw new Error("Vite+ proposal requires a frozen install and coordinated migration");
  if (
    !validVersion(bundled.vitest) ||
    catalog.vite !== `npm:@voidzero-dev/vite-plus-core@${selected}` ||
    object(manifests.vite).name !== "@voidzero-dev/vite-plus-core" ||
    object(manifests.vite).version !== selected ||
    catalog.vitest !== bundled.vitest ||
    object(manifests.vitest).version !== bundled.vitest ||
    catalog["@vitest/browser-playwright"] !== bundled.vitest ||
    object(manifests["@vitest/browser-playwright"]).version !== bundled.vitest ||
    overrides["vite@*"] !== "catalog:" ||
    overrides["vitest@*"] !== "catalog:"
  )
    throw new Error(
      "Vite+ bundle, core alias, Vitest and browser provider require coordinated migration",
    );
}

export function assertBrowserPackageCompatibility(
  declarationValues: unknown,
  manifestValues: unknown,
) {
  const declarations = object(declarationValues);
  const manifests = object(manifestValues);
  for (const name of ["vitest", "@vitest/browser-playwright", "playwright"]) {
    const installed = object(manifests[name]);
    if (
      installed.name !== name ||
      !validVersion(installed.version) ||
      !validRange(declarations[name]) ||
      !semver.satisfies(installed.version, declarations[name])
    )
      throw new Error(`Browser package ${name} is missing or differs from its declaration`);
  }
  const provider = object(manifests["@vitest/browser-playwright"]);
  const peerDependencies = object(provider.peerDependencies);
  const dependencies = object(provider.dependencies);
  const core = object(manifests.vitest).version;
  if (!validVersion(peerDependencies.vitest) || peerDependencies.vitest !== core)
    throw new Error("Browser provider requires the exact installed Vitest peer");
  if (
    !validRange(peerDependencies.playwright) ||
    !semver.satisfies(text(object(manifests.playwright).version), peerDependencies.playwright)
  )
    throw new Error("Browser provider requires a compatible installed Playwright peer");
  for (const name of ["@vitest/browser", "@vitest/mocker"]) {
    if (
      dependencies[name] !== core ||
      object(manifests[name]).name !== name ||
      object(manifests[name]).version !== core
    )
      throw new Error(`Browser provider ${name} must match the installed Vitest peer`);
  }
}

export function checkBrowserPackageCompatibility(packageFile: string) {
  const read = (file: string): Record<string, unknown> =>
    object(JSON.parse(readFileSync(file, "utf8")));
  const declarations = { ...object(read(packageFile).devDependencies) };
  const workspaceFile = path.resolve(path.dirname(packageFile), "../../pnpm-workspace.yaml");
  const workspace = object(parse(readFileSync(workspaceFile, "utf8")));
  for (const [name, version] of Object.entries(declarations))
    if (version === "catalog:")
      declarations[name] = workspacePackageDeclaration(workspace, name, version);
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
  const bundled = object(object(repositoryRequire("vite-plus/versions")).versions);
  assertVitePlusCompatibility(workspace, manifests, bundled);
  assertBrowserPackageCompatibility(declarations, manifests);
  return Object.fromEntries(
    Object.entries(manifests).map(([name, manifest]) => [name, text(manifest.version)]),
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
