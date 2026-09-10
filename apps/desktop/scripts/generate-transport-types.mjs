import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compile } from "json-schema-to-typescript";

export function combineTransportSchemas(schemas, contract = "output") {
  const prefix = contract === "input" ? "Input" : "Output";
  const definitions = {};
  function body(schema) {
    const value = { ...schema };
    delete value.$defs;
    delete value.$schema;
    delete value.title;
    return value;
  }
  function add(name, schema) {
    const value = body(schema);
    if (
      Object.hasOwn(definitions, name) &&
      JSON.stringify(definitions[name]) !== JSON.stringify(value)
    ) {
      throw new Error(`Rust transport schemas disagree about ${name}`);
    }
    definitions[name] = value;
  }
  for (const schema of Object.values(schemas)) {
    for (const [name, definition] of Object.entries(schema.$defs ?? {}))
      add(name, definition);
  }
  const properties = {};
  for (const [key, schema] of Object.entries(schemas)) {
    // A root export and a nested definition often name the same Rust type.
    // Reuse that declaration only when the complete schema body is identical.
    const matching = Object.entries(definitions).find(
      ([, definition]) =>
        JSON.stringify(definition) === JSON.stringify(body(schema)),
    );
    const name =
      matching?.[0] ??
      `${prefix}${key
        .split("_")
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("")}`;
    add(name, schema);
    properties[key] = { $ref: `#/$defs/${name}` };
  }
  return {
    type: "object",
    title: `Transport${prefix}s`,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    $defs: definitions,
  };
}

export async function renderTransportTypes(schemas, contract = "output") {
  return compile(
    combineTransportSchemas(schemas, contract),
    "TransportContracts",
    {
      bannerComment: `// Generated from Rust ${contract} schemas. Do not edit.\n// Regenerate: node apps/desktop/scripts/generate-transport-types.mjs --write`,
      unknownAny: true,
      // The complete schema inventory is local. References may never fetch input.
      $refOptions: { resolve: { http: false, file: false } },
    },
  );
}

function withHostSchemas(core, host) {
  const combined = { ...core };
  for (const [name, schema] of Object.entries(host)) {
    const key = `desktop_${name}`;
    if (Object.hasOwn(combined, key))
      throw new Error(`Desktop schema key collides with core: ${key}`);
    combined[key] = schema;
  }
  return combined;
}

async function main() {
  const { values } = parseArgs({
    options: { write: { type: "boolean", default: false } },
  });
  const source = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src",
  );
  const schemas = JSON.parse(
    fs.readFileSync(
      path.join(source, "transport-schemas.generated.json"),
      "utf8",
    ),
  );
  const inputs = JSON.parse(
    fs.readFileSync(
      path.join(source, "transport-inputs.generated.json"),
      "utf8",
    ),
  );
  const hostInput = JSON.parse(
    fs.readFileSync(
      path.join(source, "transport-host-input.generated.json"),
      "utf8",
    ),
  );
  const hostOutput = JSON.parse(
    fs.readFileSync(
      path.join(source, "transport-host-output.generated.json"),
      "utf8",
    ),
  );
  for (const [name, expected] of [
    [
      "transport-types.generated.d.ts",
      await renderTransportTypes(withHostSchemas(schemas, hostOutput)),
    ],
    [
      "transport-input-types.generated.d.ts",
      await renderTransportTypes(withHostSchemas(inputs, hostInput), "input"),
    ],
  ]) {
    const target = path.join(source, name);
    if (values.write) fs.writeFileSync(target, expected);
    if (fs.readFileSync(target, "utf8").replaceAll("\r\n", "\n") !== expected)
      throw new Error(
        `Generated TypeScript transport declarations differ from the Rust schema snapshot: ${name}`,
      );
  }
  console.log(
    "TypeScript transport declarations match the Rust schema snapshot.",
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  await main();
