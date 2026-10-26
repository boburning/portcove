import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorMessage } from "./runtime-values.mts";

export const nodeTestPath = /^scripts\/[^/]+\.test\.[cm]?[jt]s$/u;
const nativeNodeTestPath = /^apps\/desktop\/scripts\/[a-z0-9-]+\.native\.test\.mts$/u;
const registeredTestPath = (file: string) =>
  nodeTestPath.test(file) || nativeNodeTestPath.test(file);
export interface NodePlatformSkipContract {
  platform: "linux" | "win32";
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
  platformSkips?: Record<string, NodePlatformSkipContract>;
}
function registerPlatformSkips(
  entry: Record<string, unknown>,
  file: string,
  memberships: ReadonlySet<string>,
  contracts: Record<string, NodePlatformSkipContract>,
  owners: Record<string, Record<string, string>>,
) {
  const value = entry.platform_skips;
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "cases,owner,platform,prerequisite,reason"
  )
    throw new Error("Invalid platform skip contract: " + file);
  if (value.platform !== "linux" && value.platform !== "win32")
    throw new Error("Unknown platform skip target: " + file);
  const owner = value.owner;
  if (typeof owner !== "string" || !memberships.has(owner))
    throw new Error("Platform skip owner must execute its file: " + file);
  for (const key of ["prerequisite", "reason"] as const)
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 1024)
      throw new Error("Platform skip prerequisite/reason missing: " + file);
  const cases = value.cases;
  if (
    !Array.isArray(cases) ||
    !cases.length ||
    cases.length > 128 ||
    !cases.every(
      (name: unknown) => typeof name === "string" && name.trim() && name.length <= 2048,
    ) ||
    new Set(cases).size !== cases.length
  )
    throw new Error("Invalid platform skip case inventory: " + file);
  const platform = value.platform === "linux" ? "linux-x86_64" : "windows-x86_64";
  const existing = owners[file]?.[platform];
  if (existing !== undefined && existing !== owner)
    throw new Error("Platform skip qualification owner conflicts: " + file);
  owners[file] = { ...owners[file], [platform]: owner };
  contracts[file] = {
    platform: value.platform,
    owner,
    prerequisite: value.prerequisite as string,
    reason: value.reason as string,
    cases: cases as string[],
  };
}
function expandNodeTestOwnership(
  value: Record<string, unknown>,
  qualificationOwners: Record<string, Record<string, string>>,
  platformSkips: Record<string, NodePlatformSkipContract>,
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
        (key) => !["file", "memberships", "qualification", "platform_skips"].includes(key),
      ) ||
      typeof entry.file !== "string" ||
      !registeredTestPath(entry.file) ||
      seenFiles.has(entry.file) ||
      !Array.isArray(entry.memberships) ||
      !entry.memberships.length
    )
      throw new Error("Invalid or repeated Node test ownership record");
    seenFiles.add(entry.file);
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
  const platformSkips: Record<string, NodePlatformSkipContract> = {};
  if (isRecord(value) && value.format_version === 2)
    value = expandNodeTestOwnership(value, qualificationOwners, platformSkips);
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

export function annotatedNodeCommands(source: string, registry: NodeTestSuites) {
  const lines = source.split(/\r?\n/u);
  const invocations: { id: string; arguments: string[]; files: string[] }[] = [];
  const matchedLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*# node-suite: ([a-z][a-z0-9-]*)\s*$/u.exec(lines[i] ?? "");
    if (!match && /^\s*# node-suite:/u.test(lines[i] ?? ""))
      throw new Error("Nonliteral Node suite annotation");
    if (!match) continue;
    const id = match[1] ?? "";
    const suite = registry.suites[id];
    if (!suite) throw new Error(`Unknown Node suite: ${id}`);
    let command = (lines[++i] ?? "").trim();
    matchedLines.add(i);
    for (const prefix of ["& ", "{{storage}} ", "node scripts/dev-storage.mts run -- "])
      if (command.startsWith(prefix)) command = command.slice(prefix.length);
    const args = commandTokens(command);
    if (
      args.shift() !== "node" ||
      JSON.stringify(args) !== JSON.stringify([...suite.arguments, ...suite.files])
    )
      throw new Error(`Node suite ${id} generated command differs from registry`);
    invocations.push({ id, ...suite });
  }
  for (const [index, line] of lines.entries()) {
    if (matchedLines.has(index)) continue;
    if (
      /^\s*(?:& |\{\{storage\}\} |node scripts\/dev-storage\.mts run -- )?node --test\b/u.test(
        line,
      ) &&
      /\sscripts\/[^/\s]+\.test\.[cm]?[jt]s(?=\s|$)/u.test(line)
    )
      throw new Error("Root Node test invocation has no suite annotation");
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
      else annotatedNodeCommands(source, registry);
    }
    console.log(`Node suite commands ${mode === "--write" ? "generated" : "verified"}`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
