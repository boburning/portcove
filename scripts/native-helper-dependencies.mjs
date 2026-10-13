import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity } from "./development-evidence.mjs";

const desktop = "apps/desktop/scripts/";
const helper = (name) => `${desktop}${name}`;
// Declared dependencies, including conditional branches. Capture proves source
// bytes, not that every branch executed. System assemblies are runtime inputs.
export const nativeHelperDependencies = Object.freeze(
  Object.fromEntries(
    [
      [
        "desktop-test.mjs",
        [
          "desktop-native-confirmation.mjs",
          "desktop-owned-native-session.mjs",
          "desktop-startup-observation.mjs",
          "native-session.ps1",
        ],
      ],
      ["desktop-native-confirmation.mjs", ["native-confirmation.ps1"]],
      ["desktop-owned-native-session.mjs", []],
      ["desktop-startup-observation.mjs", ["native-startup-observation.ps1"]],
      ["native-confirmation.ps1", ["native-process-tree.ps1", "native-window-discovery.ps1"]],
      ["native-session.ps1", ["native-process-tree.ps1"]],
      ["native-startup-observation.ps1", ["native-process-tree.ps1"]],
      ["native-process-tree.ps1", []],
      ["native-window-discovery.ps1", []],
    ].map(([name, dependencies]) => [helper(name), Object.freeze(dependencies.map(helper))]),
  ),
);
export const nativeHelperRegistryPath = "scripts/native-helper-dependencies.mjs";

function safeFile(file) {
  if (
    typeof file !== "string" ||
    !file.startsWith(desktop) ||
    file.includes("\\") ||
    file.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new Error(`Unsafe native helper dependency: ${file}`);
  return file;
}

export function nativeHelperFiles(roots, registry = nativeHelperDependencies) {
  const visited = new Set();
  const visit = (file, pending = new Set()) => {
    safeFile(file);
    if (!Object.hasOwn(registry, file)) throw new Error(`Undeclared native helper: ${file}`);
    if (pending.has(file)) throw new Error(`Cyclic native helper dependency: ${file}`);
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of registry[file]) visit(dependency, new Set([...pending, file]));
  };
  for (const file of roots) visit(file);
  return [...visited];
}

export function nativeHelperSourceDependencies(
  file,
  source,
  registry = nativeHelperDependencies,
  dotSources,
) {
  const result = new Set();
  const relativeHelper = (name) => {
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes(".."))
      throw new Error(`Escaping native helper dependency in ${file}`);
    return safeFile(path.posix.join(path.posix.dirname(file), name));
  };
  if (file.endsWith(".ps1")) {
    // This deliberately supports only the helpers' literal dot-source grammar.
    // A different/dynamic import must be reviewed and added explicitly.
    for (const line of dotSources ??
      [...source.matchAll(/(?:^|[;{}])\s*(\.\s+[^\r\n]+)/gmu)].map((match) => match[1])) {
      const match = line.match(
        /^\s*\.\s+\(Join-Path \$PSScriptRoot ['"]([^'"]+)['"]\)\s*(?:#.*)?$/u,
      );
      if (!match)
        throw new Error(`Unsupported native helper dot-source in ${file}: ${line.trim()}`);
      if (match[1].includes("..") || match[1].includes("\\") || match[1].startsWith("/"))
        throw new Error(`Escaping native helper dependency in ${file}`);
      result.add(relativeHelper(match[1]));
    }
  } else {
    for (const match of source.matchAll(
      /new URL\(\s*["']([^"']+\.ps1)["']\s*,\s*import\.meta\.url\s*\)/gu,
    ))
      result.add(relativeHelper(match[1]));
    for (const match of source.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/gu)) {
      const candidate = relativeHelper(match[1]);
      if (Object.hasOwn(registry, candidate)) result.add(candidate);
    }
  }
  return [...result].sort();
}

function parsedDotSources(file) {
  const literal = file.replaceAll("'", "''");
  const command = `$errors = $null; $ast = [Management.Automation.Language.Parser]::ParseFile('${literal}', [ref]$null, [ref]$errors); if ($errors.Count) { throw 'Native helper parse failed' }; $entries = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.InvocationOperator -eq [Management.Automation.Language.TokenKind]::Dot }, $true) | ForEach-Object { $_.Extent.Text }); ConvertTo-Json -InputObject $entries -Compress`;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Native helper dependency parse failed: ${file}; ${result.error?.code ?? result.stderr}`,
    );
  return JSON.parse(result.stdout);
}

export async function validateNativeHelperDependencies({
  root,
  registry = nativeHelperDependencies,
} = {}) {
  const files = nativeHelperFiles(Object.keys(registry), registry);
  for (const file of files) {
    await fileIdentity(path.join(root, file)); // Missing/symlink/non-file inputs fail.
    const actual = nativeHelperSourceDependencies(
      file,
      await readFile(path.join(root, file), "utf8"),
      registry,
      process.platform === "win32" && file.endsWith(".ps1")
        ? parsedDotSources(path.join(root, file))
        : undefined,
    );
    const expected = [...new Set(registry[file])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `Native helper declaration mismatch: ${file}; declared ${expected.join(", ")}; observed ${actual.join(", ")}`,
      );
  }
  return files;
}

export function expandNativeHelperInputs(inputs) {
  const unique = new Map(inputs.map((input) => [input.path ?? `executable:${input.name}`, input]));
  const roots = inputs
    .map((input) => input.path)
    .filter((file) => Object.hasOwn(nativeHelperDependencies, file));
  for (const file of [...nativeHelperFiles(roots), nativeHelperRegistryPath])
    unique.set(file, unique.get(file) ?? { kind: "file", path: file });
  return [...unique.values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateNativeHelperDependencies({ root: fileURLToPath(new URL("../", import.meta.url)) })
    .then((files) =>
      console.log(`Native helper dependency declarations verified: ${files.length} files`),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
