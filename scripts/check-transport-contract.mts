import { errorMessage, isRecord } from "./runtime-values.mts";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderTransportSchemas } from "./transport-schemas.mts";
import { createCiMetrics } from "./ci-metrics.mts";

interface ExportResult {
  status: number | null;
  stdout: string | null | undefined;
  stderr: string | null | undefined;
  error?: Error;
}
type ExportCommand = (args: string[], root: string) => ExportResult;
const executeExport: ExportCommand = (args, root) =>
  spawnSync("cargo", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
class SchemaExportError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
const metrics = createCiMetrics();
function exportPhase<T>(phase: string, operation: () => T): T {
  const start = performance.now();
  process.stderr.write(`[transport] ${phase} started\n`);
  try {
    // Exported schemas may themselves declare error/status/signal fields. Only
    // checkedExport's thrown execution failure determines this phase outcome.
    const result = metrics.measure(`transport.${phase}`, () => ({ value: operation() })).value;
    process.stderr.write(
      `[transport] ${phase} completed (${Math.round(performance.now() - start)}ms)\n`,
    );
    return result;
  } catch (error) {
    process.stderr.write(
      `[transport] ${phase} failed (${Math.round(performance.now() - start)}ms)\n`,
    );
    throw error;
  }
}
function checkedExport(args: string[], root: string, execute: ExportCommand) {
  const command = execute(args, root);
  if (command.error || command.status !== 0) {
    const diagnostic = command.stderr || command.stdout;
    if (diagnostic) process.stderr.write(diagnostic);
    throw new SchemaExportError(
      command.error?.message ?? "Schema exporter failed",
      command.status ?? 1,
    );
  }
  const result: unknown = JSON.parse((command.stdout ?? "").trim());
  return result;
}

function capture(match: RegExpMatchArray | undefined, index: number): string {
  const value = match?.[index];
  if (value === undefined) throw new Error("Required transport source capture is missing");
  return value;
}
function declaredEvent(declarations: ReadonlyMap<string, string>, name: string): string {
  const value = declarations.get(name);
  if (value === undefined) throw new Error(`Rust emits undeclared desktop event constant: ${name}`);
  return value;
}

export function checkTransportContract(schemas: unknown, sourceText: string) {
  return sourceText.replaceAll("\r\n", "\n") === renderTransportSchemas(schemas)
    ? []
    : ["Generated transport schemas differ from the Rust output contract"];
}

function sortedUnique(values: readonly string[], label: string) {
  const sorted = [...values].sort();
  const duplicates = sorted.filter((value, index) => value === sorted[index - 1]);
  if (duplicates.length > 0)
    throw new Error(`${label} contains duplicates: ${[...new Set(duplicates)].join(", ")}`);
  return sorted;
}

export const DESKTOP_EVENT_COMPATIBILITY = Object.freeze([
  "portcove://application-update-notice",
  "portcove://library-changed",
  "portcove://operation",
]);

export const DESKTOP_EVENT_PAYLOAD_COMPATIBILITY = Object.freeze({
  DESKTOP_EVENT_APPLICATION_UPDATE_NOTICE: "ApplicationUpdateNoticeSnapshot",
  DESKTOP_EVENT_LIBRARY_CHANGED: "()",
  DESKTOP_EVENT_OPERATION: "portcove_core::OperationEvent",
});

export function extractDeclaredDesktopEvents(sourceText: string) {
  const declarationCount = [...sourceText.matchAll(/\bconst\s+DESKTOP_EVENT_[A-Z0-9_]+\b/gu)]
    .length;
  const declarations = new Map<string, string>();
  for (const match of sourceText.matchAll(
    /pub\(crate\)\s+const\s+(DESKTOP_EVENT_[A-Z0-9_]+)\s*:\s*&str\s*=\s*"(portcove:\/\/[a-z0-9-]+)"\s*;/gu,
  )) {
    if (declarations.has(capture(match, 1)))
      throw new Error(`Rust desktop event constants contain duplicates: ${capture(match, 1)}`);
    declarations.set(capture(match, 1), capture(match, 2));
  }
  if (declarations.size !== declarationCount)
    throw new Error(
      `parsed ${declarations.size} of ${declarationCount} Rust desktop event constants; declarations must remain pub(crate) &str literals`,
    );
  if (declarations.size === 0) throw new Error("the Rust desktop event inventory is empty");
  sortedUnique([...declarations.values()], "Rust desktop event names");
  return declarations;
}

export function extractProducedDesktopEvents(
  sources: readonly string[],
  declarations: ReadonlyMap<string, string>,
) {
  const producedConstants: string[] = [];
  let directEmitCalls = 0;
  let emitterAdapters = 0;
  for (const sourceText of sources) {
    if (/::\s*emit\s*(?=::|\()/u.test(sourceText))
      throw new Error("Tauri desktop event producers must route through emit_desktop_event");
    const rawCalls = [...sourceText.matchAll(/\.emit\s*(?=::|\()/gu)].length;
    directEmitCalls += rawCalls;
    const isAdapter = /fn\s+emit_desktop_event\s*</u.test(sourceText);
    if (isAdapter) emitterAdapters += 1;
    if (!isAdapter && rawCalls > 0)
      throw new Error("Tauri desktop event producers must route through emit_desktop_event");
    if (
      isAdapter &&
      (rawCalls !== 1 || !/app\.emit\s*\(\s*event\s*,\s*payload\s*\)/u.test(sourceText))
    )
      throw new Error("emit_desktop_event must contain the only direct Tauri emit call");

    const calls = [...sourceText.matchAll(/\bemit_desktop_event\s*::\s*</gu)].length;
    const parsed = [
      ...sourceText.matchAll(
        /\bemit_desktop_event\s*::\s*<\s*((?:(?:[A-Za-z_][A-Za-z0-9_]*)::)*[A-Za-z_][A-Za-z0-9_]*|\(\))\s*>\s*\(\s*[^,\r\n]+,\s*(DESKTOP_EVENT_[A-Z0-9_]+)\s*,/gu,
      ),
    ];
    if (parsed.length !== calls)
      throw new Error(
        `parsed ${parsed.length} of ${calls} typed desktop event producers; producers must bind one explicit payload type and declared event constant`,
      );
    for (const match of parsed) {
      const payloadType = capture(match, 1);
      const eventConstant = capture(match, 2);
      const expectedType = new Map(Object.entries(DESKTOP_EVENT_PAYLOAD_COMPATIBILITY)).get(
        eventConstant,
      );
      if (payloadType !== expectedType)
        throw new Error(
          `${eventConstant} producers must emit ${expectedType ?? "a known payload type"}, found ${payloadType}`,
        );
      producedConstants.push(eventConstant);
    }
  }
  if (emitterAdapters !== 1 || directEmitCalls !== 1)
    throw new Error(
      `expected exactly one typed Tauri event adapter and direct emit call, found ${emitterAdapters} adapters and ${directEmitCalls} calls`,
    );
  if (producedConstants.length === 0)
    throw new Error("the Rust desktop event producer inventory is empty");
  for (const name of producedConstants)
    if (!declarations.has(name))
      throw new Error(`Rust emits undeclared desktop event constant: ${name}`);
  return [...new Set(producedConstants.map((name) => declaredEvent(declarations, name)))].sort();
}

export function extractExportedDesktopEvents(
  sourceText: string,
  declarations: ReadonlyMap<string, string>,
) {
  const references = [...sourceText.matchAll(/\bDESKTOP_EVENT_[A-Z0-9_]+\s*\.to_owned\s*\(\s*\)/gu)]
    .length;
  const parsed = [
    ...sourceText.matchAll(
      /\b(DESKTOP_EVENT_[A-Z0-9_]+)\s*\.to_owned\s*\(\s*\)\s*,\s*output\s*::\s*<\s*((?:(?:[A-Za-z_][A-Za-z0-9_]*)::)*[A-Za-z_][A-Za-z0-9_]*|\(\))\s*>\s*\(\s*\)/gu,
    ),
  ];
  if (parsed.length !== references)
    throw new Error(
      `parsed ${parsed.length} of ${references} desktop event schema exports; exports must bind a declared event constant to one explicit payload type`,
    );
  const exported: string[] = [];
  for (const match of parsed) {
    const eventConstant = capture(match, 1);
    const payloadType = capture(match, 2);
    if (!declarations.has(eventConstant))
      throw new Error(`desktop event schemas export undeclared constant: ${eventConstant}`);
    const expectedType = new Map(Object.entries(DESKTOP_EVENT_PAYLOAD_COMPATIBILITY)).get(
      eventConstant,
    );
    if (payloadType !== expectedType)
      throw new Error(
        `${eventConstant} schema must export ${expectedType ?? "a known payload type"}, found ${payloadType}`,
      );
    exported.push(declaredEvent(declarations, eventConstant));
  }
  if (exported.length === 0) throw new Error("the desktop event schema export inventory is empty");
  return sortedUnique(exported, "desktop event schema exports");
}

function commandName(pathname: string) {
  return pathname.split("::").at(-1) ?? "";
}

export function extractRegisteredDesktopCommands(sourceText: string) {
  const inventories = [...sourceText.matchAll(/tauri::generate_handler!\s*\[([\s\S]*?)\]/gu)];
  if (inventories.length !== 1)
    throw new Error(
      `expected exactly one tauri::generate_handler! inventory, found ${inventories.length}`,
    );
  const body = capture(inventories[0], 1)
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/\/\/[^\r\n]*/gu, "");
  const paths = body
    .split(",")
    .map((entry: string) => entry.trim())
    .filter(Boolean);
  if (paths.length === 0) throw new Error("the Tauri command registration inventory is empty");
  for (const pathname of paths)
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*$/u.test(pathname))
      throw new Error(`unsupported Tauri command registration: ${pathname}`);
  return sortedUnique(paths.map(commandName), "Tauri registration inventory");
}

export function extractDeclaredDesktopCommands(sources: readonly string[]) {
  const commands = [];
  let attributes = 0;
  for (const sourceText of sources) {
    attributes += [...sourceText.matchAll(/#\s*\[\s*tauri::command\b/gu)].length;
    for (const match of sourceText.matchAll(
      /#\s*\[\s*tauri::command\s*\]\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    ))
      commands.push(capture(match, 1));
  }
  if (commands.length !== attributes)
    throw new Error(
      `parsed ${commands.length} of ${attributes} #[tauri::command] declarations; command attributes must remain bare and directly attached to a function`,
    );
  if (commands.length === 0)
    throw new Error("the Rust Tauri command declaration inventory is empty");
  return sortedUnique(commands, "Rust Tauri command declarations");
}

type Token =
  | { kind: "escaped-string" | "string" | "identifier" | "punctuation"; value: string }
  | { kind: "template"; value: null };
function sourceTokens(sourceText: string) {
  const tokens: Token[] = [];
  for (let index = 0; index < sourceText.length;) {
    const character = sourceText.charAt(index);
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (sourceText.startsWith("//", index)) {
      index = sourceText.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (sourceText.startsWith("/*", index)) {
      const end = sourceText.indexOf("*/", index + 2);
      if (end === -1) throw new Error("unterminated frontend block comment");
      index = end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      let closed = false;
      let escaped = false;
      index += 1;
      while (index < sourceText.length) {
        const next = sourceText.charAt(index);
        if (next === quote) {
          closed = true;
          index += 1;
          break;
        }
        if (next === "\\") {
          escaped = true;
          index += 2;
          continue;
        }
        value += next;
        index += 1;
      }
      if (!closed) throw new Error("unterminated frontend string literal");
      tokens.push({ kind: escaped ? "escaped-string" : "string", value });
      continue;
    }
    if (character === "`") {
      let closed = false;
      index += 1;
      while (index < sourceText.length) {
        if (sourceText[index] === "\\") {
          index += 2;
          continue;
        }
        if (sourceText[index] === "`") {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      if (!closed) throw new Error("unterminated frontend template literal");
      tokens.push({ kind: "template", value: null });
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sourceText.length && /[A-Za-z0-9_$]/u.test(sourceText.charAt(index)))
        index += 1;
      tokens.push({ kind: "identifier", value: sourceText.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function isDirectInvokeImport(tokens: readonly Token[], index: number) {
  return isDirectNamedImport(tokens, index, "invoke");
}

function isDirectNamedImport(tokens: readonly Token[], index: number, name: string) {
  if (tokens[index + 1]?.value === "as")
    throw new Error(`frontend ${name} imports must not be aliased`);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor]?.value === ";" || tokens[cursor]?.value === "}") return false;
    if (tokens[cursor]?.value === "{")
      return tokens[cursor - 1]?.kind === "identifier" && tokens[cursor - 1]?.value === "import";
  }
  return false;
}

function validateTauriCoreImports(tokens: readonly Token[]) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.kind !== "string" || tokens[index]?.value !== "@tauri-apps/api/core")
      continue;
    let statementStart = index - 1;
    while (statementStart > 0 && tokens[statementStart - 1]?.value !== ";") statementStart -= 1;
    if (
      tokens[index - 1]?.value !== "from" ||
      tokens[index - 2]?.value !== "}" ||
      tokens[statementStart]?.kind !== "identifier" ||
      tokens[statementStart]?.value !== "import" ||
      tokens[statementStart + 1]?.value !== "{"
    )
      throw new Error(
        "Tauri core APIs must use direct named imports; namespace, default, dynamic, and indirect access are unsupported",
      );
  }
}

function frontendSourceList(value: unknown): string[] {
  const raw: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (!raw.length) throw new Error("the shipped frontend source inventory is empty");
  return raw.map((source) => {
    if (typeof source !== "string") throw new Error("frontend source must be a string");
    return source;
  });
}

export function extractFrontendDesktopCommands(sourceTexts: string | readonly string[]) {
  const sources = frontendSourceList(sourceTexts);
  const commands = [];
  for (const sourceText of sources) {
    if (!/\binvoke\b/u.test(sourceText) && !sourceText.includes("@tauri-apps/api/core")) continue;
    const tokens = sourceTokens(sourceText);
    validateTauriCoreImports(tokens);
    let directImport = false;
    let directCalls = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.kind !== "identifier" || tokens[index]?.value !== "invoke") continue;
      if (isDirectInvokeImport(tokens, index)) {
        directImport = true;
        continue;
      }
      let cursor = index + 1;
      if (tokens[cursor]?.value === "<") {
        let depth = 0;
        do {
          if (tokens[cursor]?.value === "<") depth += 1;
          else if (tokens[cursor]?.value === ">") depth -= 1;
          cursor += 1;
          if (cursor >= tokens.length && depth > 0)
            throw new Error("unterminated invoke type arguments");
        } while (depth > 0);
      }
      if (tokens[cursor]?.value !== "(")
        throw new Error("frontend invoke must only be imported and called directly");
      const command = tokens[cursor + 1];
      if (command?.kind !== "string")
        throw new Error("frontend invoke commands must use a direct string literal");
      if (!/^[a-z][a-z0-9_]*$/u.test(command.value))
        throw new Error(`invalid frontend command name: ${command.value}`);
      commands.push(command.value);
      directCalls += 1;
    }
    if (directCalls > 0 && !directImport)
      throw new Error("frontend invoke calls must use a direct invoke import");
  }
  if (commands.length === 0) throw new Error("the frontend command invocation inventory is empty");
  return sortedUnique(commands, "frontend command invocations");
}

export function extractFrontendDesktopEvents(sourceTexts: string | readonly string[]) {
  const sources = frontendSourceList(sourceTexts);
  const adapterSources = sources.filter((sourceText) =>
    sourceText.includes("@tauri-apps/api/event"),
  );
  if (adapterSources.length !== 1)
    throw new Error(
      `expected exactly one shipped Tauri event adapter, found ${adapterSources.length}`,
    );
  const adapter = adapterSources[0];
  if (adapter === undefined) throw new Error("the shipped Tauri event adapter is missing");
  if (
    !/import\s*\{\s*listen\s*\}\s*from\s*["']@tauri-apps\/api\/event["']\s*;/u.test(adapter) ||
    !/export\s+function\s+listenDesktopEvent\b/u.test(adapter)
  )
    throw new Error("the shipped Tauri event adapter must directly import and export listen");
  if ([...adapter.matchAll(/\blisten\s*(?:<[^;()]*>)?\s*\(/gu)].length !== 1)
    throw new Error("the shipped Tauri event adapter must contain exactly one direct listen call");
  if (/portcove:\/\//u.test(adapter))
    throw new Error("the shipped Tauri event adapter must not embed event names");
  const events = [];
  for (const sourceText of sources) {
    if (sourceText.includes("@tauri-apps/api/event") && sourceText !== adapter)
      throw new Error("shipped frontend event consumers must use listenDesktopEvent");
    if (!/\blistenDesktopEvent\b/u.test(sourceText)) continue;
    const tokens = sourceTokens(sourceText);
    let directImport = false;
    let directCalls = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.kind !== "identifier" || tokens[index]?.value !== "listenDesktopEvent")
        continue;
      if (tokens[index - 1]?.value === "function") continue;
      if (isDirectNamedImport(tokens, index, "listenDesktopEvent")) {
        directImport = true;
        continue;
      }
      if (tokens[index + 1]?.value !== "(")
        throw new Error("frontend listenDesktopEvent must only be imported and called directly");
      const event = tokens[index + 2];
      if (event?.kind !== "string")
        throw new Error("frontend desktop events must use a direct string literal");
      if (!/^portcove:\/\/[a-z0-9-]+$/u.test(event.value))
        throw new Error(`invalid frontend desktop event name: ${event.value}`);
      events.push(event.value);
      directCalls += 1;
    }
    if (directCalls > 0 && !directImport)
      throw new Error("frontend listenDesktopEvent calls must use a direct named import");
  }
  if (events.length === 0) throw new Error("the frontend desktop event inventory is empty");
  return sortedUnique(events, "frontend desktop event consumers");
}

function inventoryDifference(expected: readonly string[], actual: readonly string[]) {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value));
}

export function checkDesktopCommandContract({
  registrationSource,
  declarationSources,
  frontendSources,
}: {
  registrationSource: string;
  declarationSources: readonly string[];
  frontendSources: string | readonly string[];
}) {
  try {
    const registered = extractRegisteredDesktopCommands(registrationSource);
    const declared = extractDeclaredDesktopCommands(declarationSources);
    const frontend = extractFrontendDesktopCommands(frontendSources);
    const failures = [];
    for (const [label, actual] of [
      ["Rust declarations", declared],
      ["frontend invocations", frontend],
    ] as const) {
      const missing = inventoryDifference(registered, actual);
      const extra = inventoryDifference(actual, registered);
      if (missing.length > 0)
        failures.push(`${label} omit registered commands: ${missing.join(", ")}`);
      if (extra.length > 0)
        failures.push(`${label} expose unregistered commands: ${extra.join(", ")}`);
    }
    return failures;
  } catch (error) {
    return [error instanceof Error ? errorMessage(error) : String(error)];
  }
}

export function checkDesktopEventContract({
  declarationSource,
  producerSources,
  exporterSource,
  frontendSources,
}: {
  declarationSource: string;
  producerSources: readonly string[];
  exporterSource: string;
  frontendSources: string | readonly string[];
}) {
  try {
    const declarations = extractDeclaredDesktopEvents(declarationSource);
    const declared = [...declarations.values()].sort();
    const produced = extractProducedDesktopEvents(producerSources, declarations);
    const exported = extractExportedDesktopEvents(exporterSource, declarations);
    const frontend = extractFrontendDesktopEvents(frontendSources);
    const failures = [];
    for (const [label, actual] of [
      ["Rust producers", produced],
      ["Rust schema exports", exported],
      ["frontend consumers", frontend],
      ["independent compatibility fixture", DESKTOP_EVENT_COMPATIBILITY],
    ] as const) {
      const missing = inventoryDifference(declared, actual);
      const extra = inventoryDifference(actual, declared);
      if (missing.length > 0) failures.push(`${label} omit declared events: ${missing.join(", ")}`);
      if (extra.length > 0) failures.push(`${label} expose undeclared events: ${extra.join(", ")}`);
    }
    return failures;
  } catch (error) {
    return [error instanceof Error ? errorMessage(error) : String(error)];
  }
}

function rustSources(directory: string): string[] {
  const sources = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...rustSources(target));
    else if (entry.isFile() && entry.name.endsWith(".rs"))
      sources.push(fs.readFileSync(target, "utf8"));
  }
  return sources;
}

function shippedFrontendSources(directory: string): string[] {
  const sources = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...shippedFrontendSources(target));
    else if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/u.test(entry.name) &&
      !/\.d\.ts$/u.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name)
    )
      sources.push(fs.readFileSync(target, "utf8"));
  }
  return sources;
}

export function exportSchemas(root: string, contract: string, execute = executeExport) {
  return exportPhase(`core-${contract}`, () => {
    const envelope = checkedExport(
      [
        "run",
        "--locked",
        "--quiet",
        "-p",
        "portcove-cli",
        "--",
        "--json",
        "schema",
        "export",
        "--contract",
        contract,
      ],
      root,
      execute,
    );
    if (
      !isRecord(envelope) ||
      !envelope.ok ||
      envelope.command !== "schema.export" ||
      !isRecord(envelope.data)
    ) {
      throw new Error("portcove schema export returned an invalid envelope");
    }
    return envelope.data;
  });
}

export function desktopSchemaExporterCommands(platform: string, verifyNative = false) {
  const commands = [
    ["run", "--locked", "--quiet", "-p", "portcove-cli", "--example", "export_desktop_transport"],
  ];
  if (platform === "win32" || verifyNative)
    commands.push([
      "run",
      "--locked",
      "--quiet",
      "-p",
      "portcove-desktop",
      "--example",
      "export_transport",
    ]);
  return commands;
}

export function checkDesktopExporterParity(headless: unknown, native: unknown) {
  return renderTransportSchemas(headless) === renderTransportSchemas(native)
    ? []
    : ["Headless Desktop schemas differ from the compiled native host"];
}

export function exportDesktopSchemas(root: string, verifyNative: boolean, execute = executeExport) {
  const results = desktopSchemaExporterCommands(process.platform, verifyNative).map((args, index) =>
    exportPhase(index === 0 ? "desktop-headless" : "desktop-native", () => {
      const result = checkedExport(args, root, execute);
      if (
        !isRecord(result) ||
        !isRecord(result.input) ||
        !isRecord(result.output) ||
        !isRecord(result.events)
      )
        throw new Error("Desktop exporter returned an invalid envelope");
      return result;
    }),
  );
  if (results.length === 2) {
    exportPhase("desktop-parity", () => {
      const failures = checkDesktopExporterParity(results[0], results[1]);
      if (failures.length) throw new Error(failures.join("\n"));
    });
    console.log("Headless Desktop contracts match the compiled native host.");
  }
  const result = results[0];
  if (!result) throw new Error("Desktop exporter inventory is empty");
  return result;
}

export function checkRepositoryDesktopExposure(root: string) {
  const failures = [];
  const desktopRustRoot = path.join(root, "apps", "desktop", "src-tauri", "src");
  const desktopExporterPath = path.join(desktopRustRoot, "desktop_contract.rs");
  const declarationSource = fs.readFileSync(desktopExporterPath, "utf8");
  const declarationSources = rustSources(desktopRustRoot);
  const frontendSources = shippedFrontendSources(path.join(root, "apps", "desktop", "src"));
  failures.push(
    ...checkDesktopCommandContract({
      registrationSource: fs.readFileSync(path.join(desktopRustRoot, "lib.rs"), "utf8"),
      declarationSources,
      frontendSources,
    }).map((message) => `Desktop commands: ${message}`),
  );
  failures.push(
    ...checkDesktopEventContract({
      declarationSource,
      producerSources: declarationSources,
      exporterSource: fs.readFileSync(desktopExporterPath, "utf8"),
      frontendSources,
    }).map((message) => `Desktop events: ${message}`),
  );
  return failures;
}

function main() {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      "ipc-only": { type: "boolean", default: false },
      "native-parity": { type: "boolean", default: false },
      types: { type: "string" },
      "host-types": { type: "string" },
      "host-events": { type: "string" },
    },
  });
  if (values.write && (values.types || values["host-types"] || values["host-events"]))
    throw new Error("--write only updates the repository generated contract");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (values["ipc-only"]) {
    if (
      values.write ||
      values.types ||
      values["host-types"] ||
      values["host-events"] ||
      values["native-parity"]
    )
      throw new Error("--ipc-only cannot write or substitute schema inputs");
    const failures = checkRepositoryDesktopExposure(root);
    if (failures.length)
      throw new Error(`Desktop command/event exposure drift:\n- ${failures.join("\n- ")}`);
    console.log("Desktop command/event exposure matches Rust.");
    return;
  }
  const schemas = exportSchemas(root, "output");
  const typesPath = values.types
    ? path.resolve(values.types)
    : path.join(root, "apps", "desktop", "src", "transport-schemas.generated.json");
  if (values.write) {
    fs.writeFileSync(typesPath, renderTransportSchemas(schemas));
  }
  const sourceText = fs.readFileSync(typesPath, "utf8");

  const failures = checkTransportContract(schemas, sourceText);
  const inputSchemas = exportSchemas(root, "input");
  const requests = Object.fromEntries(
    [
      "source_discovery_request",
      "game_file_query_request",
      "source_discovery_limits",
      "catalog_update_source",
      "definition_capability_request",
    ].map((key) => [key, inputSchemas[key]]),
  );
  const inputPath = path.join(root, "apps", "desktop", "src", "transport-inputs.generated.json");
  if (values.write) fs.writeFileSync(inputPath, renderTransportSchemas(requests));
  failures.push(
    ...checkTransportContract(requests, fs.readFileSync(inputPath, "utf8")).map(
      (message) => `Request inputs: ${message}`,
    ),
  );
  const desktop = exportDesktopSchemas(root, values["native-parity"]);
  for (const contract of ["input", "output"]) {
    const target =
      contract === "output" && values["host-types"]
        ? path.resolve(values["host-types"])
        : path.join(root, "apps", "desktop", "src", `transport-host-${contract}.generated.json`);
    if (values.write) fs.writeFileSync(target, renderTransportSchemas(desktop[contract]));
    failures.push(
      ...checkTransportContract(desktop[contract], fs.readFileSync(target, "utf8")).map(
        (message) => `Desktop ${contract}: ${message}`,
      ),
    );
  }
  const eventsPath = values["host-events"]
    ? path.resolve(values["host-events"])
    : path.join(root, "apps", "desktop", "src", "transport-host-events.generated.json");
  if (values.write) fs.writeFileSync(eventsPath, renderTransportSchemas(desktop.events));
  failures.push(
    ...checkTransportContract(desktop.events, fs.readFileSync(eventsPath, "utf8")).map(
      (message) => `Desktop events: ${message}`,
    ),
  );
  failures.push(...checkRepositoryDesktopExposure(root));
  if (failures.length > 0) {
    process.stderr.write(`Transport contract drift:\n- ${failures.join("\n- ")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    "Generated serialization schemas and desktop command/event exposure match Rust; the frontend compiler checks derived types.\n",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof SchemaExportError)) throw error;
    console.error(error.message);
    process.exitCode = error.exitCode;
  }
}
