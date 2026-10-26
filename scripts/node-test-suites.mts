import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorMessage } from "./runtime-values.mts";

export const nodeTestPath = /^scripts\/[^/]+\.test\.[cm]?[jt]s$/u;
const nativeNodeTestPath = /^apps\/desktop\/scripts\/[a-z0-9-]+\.native\.test\.mts$/u;
const registeredTestPath = (file: string) =>
  nodeTestPath.test(file) || nativeNodeTestPath.test(file);
export interface NodePlatformSkipContract {
  platform: "linux" | "win32" | "darwin" | "posix" | "any";
  category?: "platform" | "prerequisite" | "explicit-acceptance";
  required_environment?: string[];
  skip_reason_prefix?: string;
  intended_route?: string;
  owner: string;
  prerequisite: string;
  reason: string;
  cases: string[];
}
export interface NodeTestSuite {
  arguments: string[];
  files: string[];
}
export interface NodeTestSuites {
  format_version: 1;
  suites: Record<string, NodeTestSuite>;
  qualificationOwners?: Record<string, Record<string, string>>;
  platformSkips?: Record<string, NodePlatformSkipContract[]>;
  desktopDependencies?: string[];
}
function validPlatformCases(cases: unknown): cases is string[] {
  return (
    Array.isArray(cases) &&
    cases.length > 0 &&
    cases.length <= 128 &&
    cases.every(
      (name: unknown) => typeof name === "string" && name.trim() && name.length <= 2048,
    ) &&
    new Set(cases).size === cases.length
  );
}
function registerPlatformSkips(
  entry: Record<string, unknown>,
  file: string,
  memberships: ReadonlySet<string>,
  contracts: Record<string, NodePlatformSkipContract[]>,
  owners: Record<string, Record<string, string>>,
) {
  const declaration = entry.platform_skips;
  if (declaration === undefined) return;
  const values: unknown[] = Array.isArray(declaration) ? declaration : [declaration];
  if (!values.length || values.length > 128)
    throw new Error("Invalid platform skip contracts: " + file);
  const records: NodePlatformSkipContract[] = [];
  const names = new Set<string>();
  for (const value of values) {
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            "platform",
            "owner",
            "prerequisite",
            "reason",
            "cases",
            "category",
            "required_environment",
            "skip_reason_prefix",
            "intended_route",
          ].includes(key),
      )
    )
      throw new Error("Invalid platform skip contract: " + file);
    const platform = value.platform;
    if (
      platform !== "linux" &&
      platform !== "win32" &&
      platform !== "darwin" &&
      platform !== "posix" &&
      platform !== "any"
    )
      throw new Error("Invalid platform skip target: " + file);
    const category = value.category ?? "platform";
    if (
      category !== "platform" &&
      category !== "prerequisite" &&
      category !== "explicit-acceptance"
    )
      throw new Error("Invalid skip category: " + file);
    const owner = value.owner;
    if (typeof owner !== "string" || !memberships.has(owner))
      throw new Error("Platform skip owner must execute its file: " + file);
    for (const key of ["prerequisite", "reason"] as const)
      if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 1024)
        throw new Error("Platform skip prerequisite/reason missing: " + file);
    if (!validPlatformCases(value.cases) || value.cases.some((name) => names.has(name)))
      throw new Error("Invalid or overlapping platform skip case inventory: " + file);
    value.cases.forEach((name) => names.add(name));
    let requiredEnvironment: string[] | undefined;
    if (value.required_environment !== undefined) {
      if (
        category !== "explicit-acceptance" ||
        !Array.isArray(value.required_environment) ||
        !value.required_environment.length ||
        value.required_environment.length > 16 ||
        value.required_environment.some(
          (name: unknown) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name),
        ) ||
        new Set(value.required_environment).size !== value.required_environment.length
      )
        throw new Error("Invalid skip acceptance prerequisites: " + file);
      requiredEnvironment = value.required_environment.map((name: unknown) => String(name));
    }
    if (category === "explicit-acceptance" && !requiredEnvironment)
      throw new Error("Missing explicit acceptance prerequisites: " + file);
    if (
      value.intended_route !== undefined &&
      (typeof value.intended_route !== "string" ||
        !value.intended_route.trim() ||
        value.intended_route.length > 2048)
    )
      throw new Error("Invalid intended skip route: " + file);
    if (category === "explicit-acceptance" && !value.intended_route)
      throw new Error("Missing explicit acceptance route: " + file);
    if (
      value.skip_reason_prefix !== undefined &&
      (category !== "prerequisite" ||
        typeof value.skip_reason_prefix !== "string" ||
        !value.skip_reason_prefix.trim() ||
        value.skip_reason_prefix.length > 512)
    )
      throw new Error("Invalid skip reason prefix: " + file);
    if (category === "prerequisite" && !value.skip_reason_prefix)
      throw new Error("Missing prerequisite skip reason prefix: " + file);
    // Only existing exclusive platform owners affect file-level deduplication.
    // Prerequisite/acceptance and complementary POSIX routes remain non-owning.
    const targets =
      category === "platform" && platform === "linux"
        ? ["linux-x86_64"]
        : category === "platform" && platform === "win32"
          ? ["windows-x86_64"]
          : [];
    for (const target of targets) {
      const existing = owners[file]?.[target];
      if (existing !== undefined && existing !== owner)
        throw new Error("Platform skip qualification owner conflicts: " + file);
      owners[file] = { ...owners[file], [target]: owner };
    }
    records.push({
      platform,
      owner,
      prerequisite: String(value.prerequisite),
      reason: String(value.reason),
      cases: value.cases,
      ...(value.category === undefined ? {} : { category }),
      ...(requiredEnvironment ? { required_environment: requiredEnvironment } : {}),
      ...(typeof value.intended_route === "string" ? { intended_route: value.intended_route } : {}),
      ...(typeof value.skip_reason_prefix === "string"
        ? { skip_reason_prefix: value.skip_reason_prefix }
        : {}),
    });
  }
  contracts[file] = records;
}

function expandNodeTestOwnership(
  value: Record<string, unknown>,
  qualificationOwners: Record<string, Record<string, string>>,
  platformSkips: Record<string, NodePlatformSkipContract[]>,
  desktopDependencies: string[],
) {
  if (
    Object.keys(value).some((key) => !["format_version", "suites", "tests"].includes(key)) ||
    !isRecord(value.suites) ||
    !Array.isArray(value.tests) ||
    !value.tests.length
  )
    throw new Error("Invalid Node test ownership registry");
  const suites: Record<string, { arguments: unknown; files: string[] }> = {};
  const positions = new Map<string, Map<number, string>>();
  for (const [id, entry] of Object.entries(value.suites)) {
    if (
      !/^[a-z][a-z0-9-]*$/u.test(id) ||
      !isRecord(entry) ||
      Object.keys(entry).length !== 1 ||
      !Object.hasOwn(entry, "arguments")
    )
      throw new Error("Invalid Node ownership suite: " + id);
    suites[id] = { arguments: entry.arguments, files: [] };
    positions.set(id, new Map());
  }
  const seenFiles = new Set<string>();
  for (const entry of value.tests) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "file",
            "memberships",
            "qualification",
            "platform_skips",
            "desktop_dependencies",
          ].includes(key),
      ) ||
      typeof entry.file !== "string" ||
      !registeredTestPath(entry.file) ||
      seenFiles.has(entry.file) ||
      !Array.isArray(entry.memberships) ||
      !entry.memberships.length
    )
      throw new Error("Invalid or repeated Node test ownership record");
    seenFiles.add(entry.file);
    if (entry.desktop_dependencies !== undefined) {
      if (entry.desktop_dependencies !== true)
        throw new Error("Invalid Desktop dependency ownership: " + entry.file);
      desktopDependencies.push(entry.file);
    }
    const seenSuites = new Set<string>();
    for (const membership of entry.memberships) {
      if (!Array.isArray(membership) || membership.length !== 2)
        throw new Error("Invalid Node test ownership membership: " + entry.file);
      const id: unknown = membership[0];
      const position: unknown = membership[1];
      if (
        typeof id !== "string" ||
        typeof position !== "number" ||
        !Number.isSafeInteger(position) ||
        position < 0
      )
        throw new Error("Invalid Node test ownership membership: " + entry.file);
      const suite = positions.get(id);
      if (!suite || seenSuites.has(id) || suite.has(position))
        throw new Error("Unknown or repeated Node test ownership position: " + entry.file);
      seenSuites.add(id);
      suite.set(position, entry.file);
    }
    if (entry.qualification !== undefined) {
      if (!isRecord(entry.qualification) || !Object.keys(entry.qualification).length)
        throw new Error("Invalid qualification ownership: " + entry.file);
      const owners: Record<string, string> = {};
      for (const [platform, id] of Object.entries(entry.qualification)) {
        if (
          !["linux-x86_64", "windows-x86_64"].includes(platform) ||
          typeof id !== "string" ||
          !seenSuites.has(id)
        )
          throw new Error("Invalid qualification ownership: " + entry.file);
        owners[platform] = id;
      }
      qualificationOwners[entry.file] = owners;
    }
    registerPlatformSkips(entry, entry.file, seenSuites, platformSkips, qualificationOwners);
  }
  for (const [id, members] of positions) {
    const suite = suites[id];
    if (!suite) throw new Error("Missing Node ownership suite: " + id);
    suite.files = [...members].sort(([left], [right]) => left - right).map(([, file]) => file);
  }
  return { format_version: 1, suites };
}

export function parseNodeTestSuites(text: string): NodeTestSuites {
  let value: unknown = JSON.parse(text);
  const qualificationOwners: Record<string, Record<string, string>> = {};
  const platformSkips: Record<string, NodePlatformSkipContract[]> = {};
  const desktopDependencies: string[] = [];
  if (isRecord(value) && value.format_version === 2)
    value = expandNodeTestOwnership(value, qualificationOwners, platformSkips, desktopDependencies);
  if (!isRecord(value) || value.format_version !== 1 || !isRecord(value.suites))
    throw new Error("Invalid Node test suite registry");
  const suites: Record<string, NodeTestSuite> = {};
  for (const [id, entry] of Object.entries(value.suites)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(id) || !isRecord(entry))
      throw new Error(`Invalid Node suite: ${id}`);
    if (
      !Array.isArray(entry.arguments) ||
      !entry.arguments.every((arg: unknown) => typeof arg === "string") ||
      entry.arguments[0] !== "--test" ||
      !Array.isArray(entry.files) ||
      !entry.files.length ||
      !entry.files.every((file: unknown) => typeof file === "string" && registeredTestPath(file)) ||
      new Set(entry.files).size !== entry.files.length
    )
      throw new Error(`Invalid Node suite arguments or files: ${id}`);
    const args: string[] = entry.arguments;
    const candidateFiles: unknown[] = entry.files;
    const files = candidateFiles.map((file) => {
      if (typeof file !== "string") throw new Error(`Invalid Node suite file: ${id}`);
      return file;
    });
    // Only maintained test-runner flags and their literal values belong here.
    for (let i = 1; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "--experimental-test-module-mocks") continue;
      if (/^--test-(?:timeout|concurrency)=\d+$/u.test(arg)) continue;
      if (/^--test-reporter=\.\/scripts\/[a-z-]+\.mts$/u.test(arg)) continue;
      if (/^--test-(?:name|skip)-pattern=.+$/u.test(arg)) continue;
      if (/^--test-(?:name|skip)-pattern$/u.test(arg) && args[++i]?.length) continue;
      throw new Error(`Unsupported Node suite flag in ${id}: ${arg}`);
    }
    suites[id] = { arguments: args, files };
  }
  if (!Object.keys(suites).length) throw new Error("Node suite registry must be nonempty");
  return {
    format_version: 1,
    suites,
    ...(Object.keys(qualificationOwners).length ? { qualificationOwners } : {}),
    ...(Object.keys(platformSkips).length ? { platformSkips } : {}),
    ...(desktopDependencies.length ? { desktopDependencies } : {}),
  };
}

/** Literal maintained shell syntax only. Never infer execution from arbitrary source text. */
export function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | null = null;
  let started = false;
  for (const character of command) {
    if (!quote && character === "|") throw new Error("Nonliteral Node suite pipeline");
    if (/[`$;&<>\r\n]/u.test(character)) throw new Error("Nonliteral Node suite command");
    if (character === quote) quote = null;
    else if (!quote && (character === '"' || character === "'")) quote = character;
    else if (!quote && /\s/u.test(character)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
      continue;
    } else token += character;
    started = true;
  }
  if (quote) throw new Error("Unsupported Node suite command quoting");
  if (started) tokens.push(token);
  return tokens;
}

export function executableNodeCommands(source: string, registry: NodeTestSuites) {
  const signatures = new Map<string, { id: string; arguments: string[]; files: string[] }>();
  for (const [id, suite] of Object.entries(registry.suites)) {
    const signature = JSON.stringify([...suite.arguments, ...suite.files]);
    if (signatures.has(signature)) throw new Error("Ambiguous Node suite executable signature");
    signatures.set(signature, { id, ...suite });
  }
  const lines = source.split(/\r?\n/u);
  const invocations: { id: string; arguments: string[]; files: string[] }[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = /^\s*# node-suite: ([a-z][a-z0-9-]*)\s*$/u.exec(line);
    if (/^\s*# node-suite:/u.test(line) && (!marker || !registry.suites[marker[1]!]))
      throw new Error("Unknown or nonliteral Node suite authoring marker");
    let command = line.trim();
    for (const prefix of ["& ", "{{storage}} ", "node scripts/dev-storage.mts run -- "])
      if (command.startsWith(prefix)) command = command.slice(prefix.length);
    if (!/^node --test(?: |$)/u.test(command)) continue;
    const args = commandTokens(command).slice(1);
    const invocation = signatures.get(JSON.stringify(args));
    if (!invocation) throw new Error("Node suite executable command differs from registry");
    const preceding = /^\s*# node-suite: ([a-z][a-z0-9-]*)\s*$/u.exec(lines[index - 1] ?? "");
    if (preceding && preceding[1] !== invocation.id)
      throw new Error("Node suite authoring marker differs from executable invocation");
    invocations.push(invocation);
  }
  return invocations;
}

function quoted(arg: string) {
  if (/^[\w./=:-]+$/u.test(arg)) return arg;
  if (/["`$\r\n]/u.test(arg)) throw new Error("Cannot render nonliteral Node suite argument");
  return `"${arg}"`;
}
export function registeredNodeCommand(id: string) {
  const registry = parseNodeTestSuites(
    readFileSync(new URL("./node-test-suites.json", import.meta.url), "utf8"),
  );
  const suite = registry.suites[id];
  if (!suite) throw new Error(`Unknown Node suite: ${id}`);
  return ["node", ...suite.arguments, ...suite.files].map(quoted).join(" ");
}

export function requireNativeNodeTestInventory(files: readonly string[], registry: NodeTestSuites) {
  const suite = registry.suites["native-tools"];
  if (!files.length || !suite || files.some((file) => !nativeNodeTestPath.test(file)))
    throw new Error("Native Node test inventory must be nonempty and owned");
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...suite.files].sort()))
    throw new Error("Native Node test ownership differs from discovered files");
}

export function generateNodeCommands(source: string, registry: NodeTestSuites) {
  const lines = source.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*# node-suite: ([a-z][a-z0-9-]*)\s*$/u.exec(lines[i] ?? "");
    if (!match) continue;
    const suite = registry.suites[match[1] ?? ""];
    if (!suite) throw new Error(`Unknown Node suite: ${match[1]}`);
    const line = lines[++i] ?? "";
    const prefix =
      /^(\s*(?:& |\{\{storage\}\} |node scripts\/dev-storage\.mts run -- )?node) --test(?: |$)/u.exec(
        line,
      )?.[1];
    if (!prefix) throw new Error(`Missing executable command for Node suite: ${match[1]}`);
    lines[i] = `${prefix} ${[...suite.arguments, ...suite.files].map(quoted).join(" ")}`;
  }
  return lines.join(source.includes("\r\n") ? "\r\n" : "\n");
}

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv.slice(2).join(" ");
    if (mode !== "--check" && mode !== "--write")
      throw new Error("usage: node-test-suites.mts --check|--write");
    const registry = parseNodeTestSuites(
      readFileSync(path.join(root, "scripts/node-test-suites.json"), "utf8"),
    );
    requireNativeNodeTestInventory(
      readdirSync(path.join(root, "apps/desktop/scripts"))
        .filter((name) => name.endsWith(".native.test.mts"))
        .map((name) => "apps/desktop/scripts/" + name),
      registry,
    );
    for (const file of [
      ".github/workflows/ci.yml",
      "justfile",
      "scripts/run-windows-qualification.ps1",
    ]) {
      const destination = path.join(root, file);
      const source = readFileSync(destination, "utf8");
      if (mode === "--write") writeFileSync(destination, generateNodeCommands(source, registry));
      else executableNodeCommands(source, registry);
    }
    console.log(`Node suite commands ${mode === "--write" ? "generated" : "verified"}`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
