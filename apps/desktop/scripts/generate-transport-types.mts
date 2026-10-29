import { isRecord } from "../../../scripts/runtime-values.mts";
// Rust owns schema contents. This adapter validates only the containers it reads;
// the schema compiler validates keywords, with all external resolution disabled.
type SchemaNode = Record<string, unknown>;
interface SchemaRoot extends SchemaNode {
  $defs?: Record<string, SchemaNode>;
}
function assertSchemas(value: unknown): asserts value is Record<string, SchemaRoot> {
  if (!isRecord(value)) throw new Error("Transport schema inventory must be an object");
  for (const schema of Object.values(value)) {
    if (
      !isRecord(schema) ||
      (schema.$defs !== undefined &&
        (!isRecord(schema.$defs) || !Object.values(schema.$defs).every(isRecord)))
    )
      throw new Error("Transport schema roots and definitions must be objects");
  }
}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compile } from "json-schema-to-typescript";

const transportContractMetadata = {
  event: { prefix: "Event", title: "DesktopEventPayloads" },
  input: { prefix: "Input", title: "TransportInputs" },
  output: { prefix: "Output", title: "TransportOutputs" },
};

function metadataForContract(contract: string) {
  return contract === "event"
    ? transportContractMetadata.event
    : contract === "input"
      ? transportContractMetadata.input
      : transportContractMetadata.output;
}

function generatedSchemaName(key: string, prefix: string) {
  const suffix = key
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `${prefix}${suffix}`;
}

export function combineTransportSchemas(schemas: unknown, contract = "output") {
  assertSchemas(schemas);
  const { prefix, title } = metadataForContract(contract);
  const definitions = new Map<string, SchemaNode>();
  function body(schema: SchemaNode) {
    const value = { ...schema };
    delete value.$defs;
    delete value.$schema;
    delete value.title;
    return value;
  }
  function add(name: string, schema: SchemaNode) {
    const value = body(schema);
    if (definitions.has(name) && JSON.stringify(definitions.get(name)) !== JSON.stringify(value)) {
      throw new Error(`Rust transport schemas disagree about ${name}`);
    }
    definitions.set(name, value);
  }
  for (const schema of Object.values(schemas)) {
    for (const [name, definition] of Object.entries(schema.$defs ?? {})) add(name, definition);
  }
  const properties = new Map<string, { $ref: string }>();
  for (const [key, schema] of Object.entries(schemas)) {
    // A root export and a nested definition often name the same Rust type.
    // Reuse that declaration only when the complete schema body is identical.
    const matching = [...definitions].find(
      ([, definition]) => JSON.stringify(definition) === JSON.stringify(body(schema)),
    );
    const name = matching?.[0] ?? generatedSchemaName(key, prefix);
    add(name, schema);
    properties.set(key, { $ref: `#/$defs/${name}` });
  }
  return {
    type: "object" as const,
    title,
    properties: Object.fromEntries(properties),
    required: [...properties.keys()],
    additionalProperties: false,
    $defs: Object.fromEntries(definitions),
  };
}

export async function renderTransportTypes(schemas: unknown, contract = "output") {
  return compile(combineTransportSchemas(schemas, contract), "TransportContracts", {
    bannerComment: `// Generated from Rust ${contract} schemas. Do not edit.\n// Regenerate: node apps/desktop/scripts/generate-transport-types.mts --write`,
    unknownAny: true,
    // The complete schema inventory is local. References may never fetch input.
    $refOptions: { resolve: { http: false, file: false } },
  });
}

function withHostSchemas(core: unknown, host: unknown) {
  assertSchemas(core);
  assertSchemas(host);
  const combined = { ...core };
  for (const [name, schema] of Object.entries(host)) {
    const key = `desktop_${name}`;
    if (Object.hasOwn(combined, key))
      throw new Error(`Desktop schema key collides with core: ${key}`);
    combined[key] = schema;
  }
  return combined;
}

/** Small runtime inventories from Core's exported enums; never load schemas in React. */
export function renderCatalogValues(schemas: unknown): string {
  assertSchemas(schemas);
  const catalog = schemas.catalog;
  if (!catalog?.$defs) throw new Error("Core catalog definitions are required");
  const names = {
    platforms: "Platform",
    channels: "ReleaseChannel",
    installationMethods: "InstallationMethod",
  };
  const inventories = Object.entries(names).map(([key, name]) => {
    const values = catalog.$defs![name]?.enum;
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((v) => typeof v !== "string") ||
      new Set(values).size !== values.length
    )
      throw new Error(`Core ${name} must be a unique string enum`);
    return `export const ${key} = ${JSON.stringify(values)} as const;`;
  });
  return "// Generated from Core catalog schemas. Do not edit.\n" + inventories.join("\n") + "\n";
}

async function main() {
  const { values } = parseArgs({
    options: { write: { type: "boolean", default: false } },
  });
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const schemas: unknown = JSON.parse(
    fs.readFileSync(path.join(source, "transport-schemas.generated.json"), "utf8"),
  );
  const inputs: unknown = JSON.parse(
    fs.readFileSync(path.join(source, "transport-inputs.generated.json"), "utf8"),
  );
  const hostInput: unknown = JSON.parse(
    fs.readFileSync(path.join(source, "transport-host-input.generated.json"), "utf8"),
  );
  const hostOutput: unknown = JSON.parse(
    fs.readFileSync(path.join(source, "transport-host-output.generated.json"), "utf8"),
  );
  const hostEvents: unknown = JSON.parse(
    fs.readFileSync(path.join(source, "transport-host-events.generated.json"), "utf8"),
  );
  const outputs: readonly (readonly [string, string])[] = [
    ["catalog-values.generated.ts", renderCatalogValues(schemas)],
    [
      "transport-types.generated.d.ts",
      await renderTransportTypes(withHostSchemas(schemas, hostOutput)),
    ],
    [
      "transport-input-types.generated.d.ts",
      await renderTransportTypes(withHostSchemas(inputs, hostInput), "input"),
    ],
    ["transport-event-types.generated.d.ts", await renderTransportTypes(hostEvents, "event")],
  ];
  for (const [name, expected] of outputs) {
    const target = path.join(source, name);
    if (values.write) fs.writeFileSync(target, expected);
    if (fs.readFileSync(target, "utf8").replaceAll("\r\n", "\n") !== expected)
      throw new Error(
        `Generated TypeScript transport declarations differ from the Rust schema snapshot: ${name}`,
      );
  }
  console.log("TypeScript transport declarations match the Rust schema snapshot.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();
