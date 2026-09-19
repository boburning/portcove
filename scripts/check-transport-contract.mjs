import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderTransportSchemas } from "./transport-schemas.mjs";

export function checkTransportContract(schemas, sourceText) {
  return sourceText.replaceAll("\r\n", "\n") === renderTransportSchemas(schemas)
    ? []
    : ["Generated transport schemas differ from the Rust output contract"];
}

function sortedUnique(values, label) {
  const sorted = [...values].sort();
  const duplicates = sorted.filter((value, index) => value === sorted[index - 1]);
  if (duplicates.length > 0)
    throw new Error(`${label} contains duplicate commands: ${[...new Set(duplicates)].join(", ")}`);
  return sorted;
}

function commandName(pathname) {
  return pathname.split("::").at(-1);
}

export function extractRegisteredDesktopCommands(sourceText) {
  const inventories = [...sourceText.matchAll(/tauri::generate_handler!\s*\[([\s\S]*?)\]/gu)];
  if (inventories.length !== 1)
    throw new Error(
      `expected exactly one tauri::generate_handler! inventory, found ${inventories.length}`,
    );
  const body = inventories[0][1]
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/\/\/[^\r\n]*/gu, "");
  const paths = body
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (paths.length === 0) throw new Error("the Tauri command registration inventory is empty");
  for (const pathname of paths)
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*$/u.test(pathname))
      throw new Error(`unsupported Tauri command registration: ${pathname}`);
  return sortedUnique(paths.map(commandName), "Tauri registration inventory");
}

export function extractDeclaredDesktopCommands(sources) {
  const commands = [];
  let attributes = 0;
  for (const sourceText of sources) {
    attributes += [...sourceText.matchAll(/#\s*\[\s*tauri::command\b/gu)].length;
    for (const match of sourceText.matchAll(
      /#\s*\[\s*tauri::command\s*\]\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    ))
      commands.push(match[1]);
  }
  if (commands.length !== attributes)
    throw new Error(
      `parsed ${commands.length} of ${attributes} #[tauri::command] declarations; command attributes must remain bare and directly attached to a function`,
    );
  if (commands.length === 0)
    throw new Error("the Rust Tauri command declaration inventory is empty");
  return sortedUnique(commands, "Rust Tauri command declarations");
}

function sourceTokens(sourceText) {
  const tokens = [];
  for (let index = 0; index < sourceText.length;) {
    const character = sourceText[index];
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
        const next = sourceText[index];
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
      while (index < sourceText.length && /[A-Za-z0-9_$]/u.test(sourceText[index])) index += 1;
      tokens.push({ kind: "identifier", value: sourceText.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return tokens;
}

function isDirectInvokeImport(tokens, index) {
  if (tokens[index + 1]?.value === "as")
    throw new Error("frontend invoke imports must not be aliased");
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor]?.value === ";" || tokens[cursor]?.value === "}") return false;
    if (tokens[cursor]?.value === "{")
      return tokens[cursor - 1]?.kind === "identifier" && tokens[cursor - 1]?.value === "import";
  }
  return false;
}

export function extractFrontendDesktopCommands(sourceTexts) {
  const sources = typeof sourceTexts === "string" ? [sourceTexts] : sourceTexts;
  if (!Array.isArray(sources) || sources.length === 0)
    throw new Error("the shipped frontend source inventory is empty");
  const commands = [];
  for (const sourceText of sources) {
    if (!/\binvoke\b/u.test(sourceText)) continue;
    const tokens = sourceTokens(sourceText);
    let directImport = false;
    let directCalls = 0;
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].kind !== "identifier" || tokens[index].value !== "invoke") continue;
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

function inventoryDifference(expected, actual) {
  const actualSet = new Set(actual);
  return expected.filter((value) => !actualSet.has(value));
}

export function checkDesktopCommandContract({
  registrationSource,
  declarationSources,
  frontendSources,
}) {
  try {
    const registered = extractRegisteredDesktopCommands(registrationSource);
    const declared = extractDeclaredDesktopCommands(declarationSources);
    const frontend = extractFrontendDesktopCommands(frontendSources);
    const failures = [];
    for (const [label, actual] of [
      ["Rust declarations", declared],
      ["frontend invocations", frontend],
    ]) {
      const missing = inventoryDifference(registered, actual);
      const extra = inventoryDifference(actual, registered);
      if (missing.length > 0)
        failures.push(`${label} omit registered commands: ${missing.join(", ")}`);
      if (extra.length > 0)
        failures.push(`${label} expose unregistered commands: ${extra.join(", ")}`);
    }
    return failures;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function rustSources(directory) {
  const sources = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...rustSources(target));
    else if (entry.isFile() && entry.name.endsWith(".rs"))
      sources.push(fs.readFileSync(target, "utf8"));
  }
  return sources;
}

function shippedFrontendSources(directory) {
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

function exportSchemas(root, contract) {
  const command = spawnSync(
    "cargo",
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
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (command.status !== 0) {
    process.stderr.write(command.stderr || command.stdout);
    process.exit(command.status ?? 1);
  }

  const envelope = JSON.parse(command.stdout.trim());
  if (!envelope.ok || envelope.command !== "schema.export") {
    throw new Error("portcove schema export returned an invalid envelope");
  }
  return envelope.data;
}

function exportDesktopSchemas(root) {
  const command = spawnSync(
    "cargo",
    ["run", "--locked", "--quiet", "-p", "portcove-desktop", "--example", "export_transport"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (command.status !== 0) {
    process.stderr.write(command.stderr || command.stdout);
    process.exit(command.status ?? 1);
  }
  return JSON.parse(command.stdout.trim());
}

function main() {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      types: { type: "string" },
      "host-types": { type: "string" },
    },
  });
  if (values.write && (values.types || values["host-types"]))
    throw new Error("--write only updates the repository generated contract");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  const desktop = exportDesktopSchemas(root);
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
  const desktopRustRoot = path.join(root, "apps", "desktop", "src-tauri", "src");
  failures.push(
    ...checkDesktopCommandContract({
      registrationSource: fs.readFileSync(path.join(desktopRustRoot, "lib.rs"), "utf8"),
      declarationSources: rustSources(desktopRustRoot),
      frontendSources: shippedFrontendSources(path.join(root, "apps", "desktop", "src")),
    }).map((message) => `Desktop commands: ${message}`),
  );
  if (failures.length > 0) {
    process.stderr.write(`Transport contract drift:\n- ${failures.join("\n- ")}\n`);
    process.exit(1);
  }

  process.stdout.write(
    "Generated serialization schemas and desktop command exposure match Rust; the frontend compiler checks derived types.\n",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
