import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { fileIdentity, writeEvidence } from "./development-evidence.mts";
import { retainEvidenceInput } from "./retained-evidence.mts";
import { errorCode, errorMessage } from "./runtime-values.mts";

const desktop = "apps/desktop/scripts/";
const helper = (name: string) => `${desktop}${name}`;
export type NativeHelperRegistry = Readonly<Record<string, readonly string[]>>;
export type ReceiptInput =
  | { kind: "file"; path: string; name?: never }
  | { kind: "executable" | "argument-file"; name: string; path?: never };
// Declared dependencies, including conditional branches. Capture proves source
// bytes, not that every branch executed. System assemblies are runtime inputs.
export const nativeHelperDependencies: NativeHelperRegistry = Object.freeze(
  Object.fromEntries(
    (
      [
        [
          "desktop-native-confirmation.mts",
          ["native-confirmation.ps1", "native-linux-folder-picker.py"],
        ],
        ["native-linux-folder-picker.py", []],
        ["desktop-owned-native-session.mts", ["native-session.ps1"]],
        ["desktop-native-account-session.mts", ["desktop-owned-native-session.mts"]],
        ["desktop-linux-native-session.mts", ["native-linux-init.mts"]],
        ["desktop-linux-webkit-inspector.mts", []],
        ["native-linux-init.mts", []],
        ["desktop-startup-observation.mts", ["native-startup-observation.ps1"]],
        ["native-confirmation.ps1", ["native-process-tree.ps1", "native-window-discovery.ps1"]],
        ["native-session.ps1", ["native-process-tree.ps1"]],
        ["native-startup-observation.ps1", ["native-process-tree.ps1"]],
        ["native-process-tree.ps1", []],
        ["native-window-discovery.ps1", []],
      ] as const
    ).map(([name, dependencies]) => [helper(name), Object.freeze(dependencies.map(helper))]),
  ),
);
export const nativeHelperRegistryPath = "scripts/native-helper-dependencies.mts";
// Shared repository launcher boundary, captured but not recursively classified as
// a native helper graph. All other non-builtin imports must be declared helpers.
export const nativeWrapperSharedImports: NativeHelperRegistry = Object.freeze({
  [helper("desktop-native-account-session.mts")]: Object.freeze([
    "../../../scripts/native-qualification-account-client.mts",
  ]),
  [helper("desktop-linux-native-session.mts")]: Object.freeze([
    "../../../scripts/runtime-values.mts",
  ]),
  [helper("desktop-linux-webkit-inspector.mts")]: Object.freeze([
    "../../../scripts/runtime-values.mts",
  ]),
  [helper("desktop-native-confirmation.mts")]: Object.freeze([
    "../../../scripts/dev-storage.mts",
    "../../../scripts/runtime-values.mts",
  ]),
});
export const nativeHelperSharedSources = Object.freeze([
  "apps/desktop/test/capture-target.ts",
  "scripts/native-qualification-account-client.ps1",
  "scripts/native-qualification-account.cs.txt",
  // Launcher and admission code is already loaded when prelaunch capture begins.
  // These are trusted verifier/reproduction observations, never proof that a
  // retained copy was the immutable module consumed by the target process.
  "scripts/resource-command.mts",
  "scripts/resource-capacity.mts",
  "scripts/resource-paths.mts",
  "scripts/fallow-source.mts",
  "scripts/run-rust-tests.mts",
  "scripts/rust-support-cache.mts",
  "scripts/ci-metrics.mts",
  "scripts/validation-plan.mts",
  "scripts/nextest-equivalence.mts",
  "scripts/report-summary.mts",
  "scripts/bounded-summary.mts",
  "scripts/fallow-summary.mts",
  "scripts/heavy-rust-test-lock.mts",
  "scripts/process-lock.mts",
  "scripts/tool-cache.mts",
  "scripts/rust-test-tree-supervisor.mts",
  "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  "scripts/runtime-values.mts",
  ...new Set(
    Object.values(nativeWrapperSharedImports)
      .flat()
      .map((specifier: string) => path.posix.normalize(path.posix.join(desktop, specifier))),
  ),
]);
export const nativeHelperRoots = Object.freeze(
  [
    "desktop-native-confirmation.mts",
    "desktop-owned-native-session.mts",
    "desktop-native-account-session.mts",
    "desktop-linux-native-session.mts",
    "desktop-linux-webkit-inspector.mts",
    "desktop-startup-observation.mts",
  ].map(helper),
);

function safeFile(file: string): string {
  if (
    typeof file !== "string" ||
    !file.startsWith(desktop) ||
    file.includes("\\") ||
    file.split("/").some((part) => ["", ".", ".."].includes(part))
  )
    throw new Error(`Unsafe native helper dependency: ${file}`);
  return file;
}

export function nativeHelperFiles(
  roots: readonly string[],
  registry: NativeHelperRegistry = nativeHelperDependencies,
): string[] {
  const visited = new Set<string>();
  const visit = (file: string, pending = new Set<string>()): void => {
    safeFile(file);
    const dependencies = Object.hasOwn(registry, file) ? registry[file] : undefined;
    if (!dependencies) throw new Error(`Undeclared native helper: ${file}`);
    if (pending.has(file)) throw new Error(`Cyclic native helper dependency: ${file}`);
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of dependencies) visit(dependency, new Set([...pending, file]));
  };
  for (const file of roots) visit(file);
  return [...visited];
}

export function nativeHelperSourceDependencies(
  file: string,
  source: string,
  registry: NativeHelperRegistry = nativeHelperDependencies,
  dotSources?: readonly string[],
) {
  const result = new Set<string>();
  const relativeHelper = (name: string) => {
    if (name.includes("\\") || name.startsWith("/") || name.split("/").includes(".."))
      throw new Error(`Escaping native helper dependency in ${file}`);
    return safeFile(path.posix.join(path.posix.dirname(file), name));
  };
  if (file.endsWith(".ps1")) {
    // This deliberately supports only the helpers' literal dot-source grammar.
    // A different/dynamic import must be reviewed and added explicitly.
    for (const line of dotSources ??
      [...source.matchAll(/(?:^|[;{}])\s*(\.\s+[^\r\n]+)/gmu)].map((match) => match[1] ?? "")) {
      const match = line.match(
        /^\s*\.\s+\(Join-Path \$PSScriptRoot ['"]([^'"]+)['"]\)\s*(?:#.*)?$/u,
      );
      if (!match?.[1])
        throw new Error(`Unsupported native helper dot-source in ${file}: ${line.trim()}`);
      if (match[1].includes("..") || match[1].includes("\\") || match[1].startsWith("/"))
        throw new Error(`Escaping native helper dependency in ${file}`);
      result.add(relativeHelper(match[1]));
    }
  } else if (file.endsWith(".py")) {
    if (file !== helper("native-linux-folder-picker.py"))
      throw new Error(`Unsupported Python native helper: ${file}`);
    const runtimeImports = new Set([
      "argparse",
      "hashlib",
      "json",
      "os",
      "select",
      "time",
      "sys",
      "pathlib",
      "gi",
      "gi.repository",
    ]);
    for (const expression of source.matchAll(
      /^\s*(?:import\s+([^\r\n]+)|from\s+([^\s]+)\s+import\s+[^\r\n]+)$/gmu,
    )) {
      const module = (expression[1] ?? expression[2] ?? "").trim();
      if (!runtimeImports.has(module))
        throw new Error(`Undeclared Python runtime import in ${file}: ${module}`);
    }
    if (/\b(?:__import__|exec|eval)\s*\(/u.test(source))
      throw new Error(`Unsupported dynamic Python helper import in ${file}`);
  } else {
    // Observe exactly what native Node executes. Whole type-only imports are
    // erased; inline type specifiers may retain a runtime side-effect import.
    // Strip mode rejects non-erasable syntax and leaves the existing fail-closed
    // runtime import/URL grammar unchanged.
    if (/\.[cm]?ts$/u.test(file)) source = stripTypeScriptTypes(source, { mode: "strip" });
    for (const expression of source.matchAll(/\bnew\s+URL\s*\(([^)]*)\)/gu)) {
      const match = (expression[1] ?? "").match(
        /^\s*["']([^"']+\.(?:ps1|mjs|mts|py))["']\s*,\s*import\.meta\.url\s*$/u,
      );
      if (!match?.[1])
        throw new Error(`Unsupported native wrapper URL in ${file}: ${expression[0]}`);
      const dependency = relativeHelper(match[1]);
      if (!Object.hasOwn(registry, dependency))
        throw new Error(`Undeclared native wrapper URL in ${file}: ${dependency}`);
      result.add(dependency);
    }
    for (const match of source.matchAll(/\b(?:from|import)\s+["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (!specifier) throw new Error(`Unsupported native wrapper import in ${file}`);
      if (specifier.startsWith("node:") || nativeWrapperSharedImports[file]?.includes(specifier))
        continue;
      const candidate = relativeHelper(specifier);
      if (!Object.hasOwn(registry, candidate))
        throw new Error(`Undeclared native wrapper import in ${file}: ${candidate}`);
      result.add(candidate);
    }
    if (/\bimport\s*\(/u.test(source))
      throw new Error(`Unsupported dynamic native wrapper import in ${file}`);
  }
  return [...result].sort();
}

function parsedDotSources(file: string): string[] {
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
      `Native helper dependency parse failed: ${file}; ${errorCode(result.error) ?? result.stderr}`,
    );
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || !parsed.every((line: unknown) => typeof line === "string"))
    throw new Error(`Native helper dependency parser returned invalid dot sources: ${file}`);
  return parsed;
}

export async function validateNativeHelperDependencies({
  root,
  registry = nativeHelperDependencies,
}: { root?: string; registry?: NativeHelperRegistry } = {}) {
  if (typeof root !== "string")
    throw new TypeError("Native helper validation requires a checkout root");
  const files = nativeHelperFiles(Object.keys(registry), registry);
  if (registry === nativeHelperDependencies) {
    for (const file of nativeHelperSharedSources) await fileIdentity(path.join(root, file));
    const consumer = await readFile(path.join(root, helper("desktop-test.mts")), "utf8");
    const imports = new Set(
      [...consumer.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/gu)].map((match) =>
        helper((match[1] ?? "").slice(2)),
      ),
    );
    for (const wrapper of nativeHelperRoots)
      if (!imports.has(wrapper))
        throw new Error(`Native coordinator omitted declared wrapper: ${wrapper}`);
    if (/new\s+URL\s*\([^)]*\.ps1|["'`]\.\/native-[^"'`]+\.ps1/u.test(consumer))
      throw new Error(
        "Native coordinator must resolve PowerShell helpers through declared wrappers",
      );
  }
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

export function expandNativeHelperInputs(inputs: readonly ReceiptInput[]): ReceiptInput[] {
  const unique = new Map<string, ReceiptInput>(
    inputs.map((input) => [input.path ?? `executable:${input.name}`, input]),
  );
  const roots = inputs
    .map((input) => input.path)
    .filter(
      (file): file is string => file !== undefined && Object.hasOwn(nativeHelperDependencies, file),
    );
  if (inputs.some((input) => input.path === helper("desktop-test.mts")))
    roots.push(...nativeHelperRoots);
  for (const file of [
    ...nativeHelperFiles(roots),
    ...(roots.length ? nativeHelperSharedSources : []),
    nativeHelperRegistryPath,
  ])
    unique.set(file, unique.get(file) ?? { kind: "file", path: file });
  return [...unique.values()];
}

// Production pre-launch capture boundary. If a source/helper fails, retain the
// partial observed identities and fail the receipt; unavailable bytes stay absent.
export async function captureDesktopReceiptInputs({
  root,
  values,
  plan,
  output,
  revision,
  validate = validateNativeHelperDependencies,
  retainedRoot = null,
  signal,
}: {
  root: string;
  values: Readonly<{
    app: string;
    [argument: string]: string | boolean | readonly string[] | undefined;
  }>;
  plan: {
    receiptInputs: readonly ReceiptInput[];
    selection: { selected_scenarios: readonly string[] };
  };
  output: string;
  revision: string;
  validate?: typeof validateNativeHelperDependencies;
  retainedRoot?: string | null;
  signal?: AbortSignal | undefined;
}) {
  type CapturedInput =
    | Awaited<ReturnType<typeof fileIdentity>>
    | (Awaited<ReturnType<typeof retainEvidenceInput>> & {
        role: string;
        kind: ReceiptInput["kind"];
      });
  const inputs: CapturedInput[] = [];
  let failedPath;
  try {
    for (const input of plan.receiptInputs) {
      const source = input.kind !== "file" ? values[input.name] : path.join(root, input.path);
      failedPath = typeof source === "string" ? source : (input.name ?? input.path);
      if (typeof source !== "string")
        throw new TypeError(`Missing native input: ${input.name ?? input.path}`);
      failedPath = source;
      inputs.push(
        retainedRoot
          ? {
              ...(await retainEvidenceInput({
                root: retainedRoot,
                file: failedPath,
                executable: input.kind === "executable",
                ...(signal === undefined ? {} : { signal }),
              })),
              role: input.kind !== "file" ? input.name : input.path,
              kind: input.kind,
            }
          : await fileIdentity(failedPath),
      );
    }
    failedPath = "native-helper-dependency-validation";
    await validate({ root });
    return inputs;
  } catch (error) {
    const artifact = path.join(output, "input-capture-failure.json");
    await writeFile(
      artifact,
      `${JSON.stringify({ complete: false, failed_path: failedPath, message: errorMessage(error), captured_inputs: inputs.length, declared_inputs: plan.receiptInputs.length }, null, 2)}\n`,
      { flag: "wx" },
    );
    if (inputs[0])
      await writeEvidence(output, {
        revision,
        executable: values.app,
        capturedExecutable: inputs[0],
        checks: [
          { scenario: "native-input-capture", outcome: "failed", message: errorMessage(error) },
        ],
        artifacts: [artifact],
        inputs,
        method: "native-desktop-input-capture",
        context: {
          selected_scenarios: plan.selection.selected_scenarios,
          source_state: { revision, clean: null },
        },
      });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateNativeHelperDependencies({ root: fileURLToPath(new URL("../", import.meta.url)) })
    .then((files) =>
      console.log(`Native helper dependency declarations verified: ${files.length} files`),
    )
    .catch((error: unknown) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    });
}
