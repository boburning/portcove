import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderTransportSchemas } from "./transport-schemas.mjs";

export function checkTransportContract(schemas, sourceText) {
  return sourceText.replaceAll("\r\n", "\n") === renderTransportSchemas(schemas)
    ? [] : ["Generated transport schemas differ from the Rust output contract"];
}

function exportSchemas(root, contract) {
  const command = spawnSync(
    "cargo",
    ["run", "--locked", "--quiet", "-p", "portcove-cli", "--", "--json", "schema", "export", "--contract", contract],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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

function main() {
  const { values } = parseArgs({ options: { write: { type: "boolean", default: false }, types: { type: "string" } } });
  if (values.write && values.types) throw new Error("--write only updates the repository generated contract");
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
  const requests = Object.fromEntries(["source_discovery_request", "source_discovery_limits", "catalog_update_source"].map(key => [key, inputSchemas[key]]));
  const inputPath = path.join(root, "apps", "desktop", "src", "transport-inputs.generated.json");
  if (values.write) fs.writeFileSync(inputPath, renderTransportSchemas(requests));
  failures.push(...checkTransportContract(requests, fs.readFileSync(inputPath, "utf8")).map(message => `Request inputs: ${message}`));
  if (failures.length > 0) {
    process.stderr.write(`Transport contract drift:\n- ${failures.join("\n- ")}\n`);
    process.exit(1);
  }

  process.stdout.write("Generated serialization schemas match Rust; the frontend compiler checks their derived types.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
