/** Native authored records remain proposals. Core, never this translator, owns
 * catalog/source/launch/settings admission. No descriptor-controlled execution. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assembleCatalogRecords,
  checkedAuthoredPort,
  parseCatalogSource,
  projectAuthoredPort,
  readCatalogSource,
  type AuthoredPort,
} from "./catalog-authoring.mts";
import { coreProposalInspector, type ProposalReceipt } from "./catalog-authoring-inspector.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { readBoundedEvidenceFile } from "./development-evidence.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const maximumDescriptorBytes = 256 * 1024;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export interface DescriptorInspector {
  portSchema: Record<string, unknown>;
  artifactSha256: string;
  inspect: (name: string, bytes: Buffer) => ProposalReceipt;
}

/** Field names come from the captured Core INPUT schema, not another port
 * schema. Core separately validates types, constraints and all source contracts. */
export function unknownDescriptorFields(value: unknown, schema: unknown): string[] {
  if (!isRecord(schema)) throw new Error("Core port input schema is unavailable.");
  const errors: string[] = [];
  let visited = 0;
  const candidates = (input: unknown, depth = 0): Record<string, unknown>[] => {
    if (!isRecord(input) || depth > 32) return [];
    if (typeof input.$ref === "string") {
      if (!input.$ref.startsWith("#/$defs/")) throw new Error("Unsupported Core schema reference.");
      const name = input.$ref.slice(8).replaceAll("~1", "/").replaceAll("~0", "~");
      if (!isRecord(schema.$defs) || !Object.hasOwn(schema.$defs, name))
        throw new Error("Core schema reference is missing.");
      return candidates(schema.$defs[name], depth + 1);
    }
    const alternatives = Array.isArray(input.anyOf) ? input.anyOf : input.oneOf;
    return Array.isArray(alternatives)
      ? alternatives.flatMap((option) => candidates(option, depth + 1))
      : [input];
  };
  const visit = (value: unknown, schemas: unknown[], location: string, depth: number) => {
    if (++visited > 8192 || depth > 32)
      throw new Error("Descriptor exceeds its structural bounds.");
    const options = schemas.flatMap((schema) => candidates(schema));
    if (Array.isArray(value)) {
      const items = options.flatMap((option) => (option.items ? [option.items] : []));
      if (items.length)
        value.forEach((item, index) => visit(item, items, `${location}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    const objects = options.filter(
      (option) =>
        option.type === "object" ||
        isRecord(option.properties) ||
        Object.hasOwn(option, "additionalProperties"),
    );
    // Arbitrary JSON values are data, not unknown executable field declarations.
    if (!objects.length) return;
    for (const [key, child] of Object.entries(value)) {
      const properties = objects.flatMap((option) =>
        isRecord(option.properties) && Object.hasOwn(option.properties, key)
          ? [option.properties[key]]
          : [],
      );
      const maps = objects.flatMap((option) =>
        isRecord(option.additionalProperties) ? [option.additionalProperties] : [],
      );
      if (
        !properties.length &&
        !maps.length &&
        !objects.some((option) => option.additionalProperties === true)
      ) {
        if (errors.length < 32) errors.push(`${location}.${key}`);
      } else {
        visit(child, properties.length ? properties : maps, `${location}.${key}`, depth + 1);
      }
    }
  };
  visit(value, [schema], "integration", 0);
  return errors;
}

function withoutSettings(record: AuthoredPort): AuthoredPort {
  const copy = structuredClone(record);
  if (copy.integration) delete copy.integration.game_settings;
  return copy;
}

export function inspectPortDescriptor({
  bytes,
  records,
  shared,
  inspector,
}: {
  bytes: Buffer;
  records: AuthoredPort[];
  shared: unknown;
  inspector: DescriptorInspector;
}) {
  if (bytes.length > maximumDescriptorBytes || !bytes.equals(Buffer.from(bytes.toString("utf8"))))
    throw new Error("Descriptor must be bounded UTF-8 native JSON.");
  const descriptor = checkedAuthoredPort(parseCatalogSource(bytes.toString("utf8")));
  const rootFields = new Set([
    "format_version",
    "listing",
    "integration",
    "order",
    "upstream_lineage",
    "release_maintenance",
  ]);
  if (Object.keys(descriptor).some((field) => !rootFields.has(field)))
    throw new Error(
      "Unsupported native descriptor field; use the documented authored-record contract, not another launcher's schema.",
    );
  if (!descriptor.integration)
    throw new Error("A basic game-author descriptor requires an integration.");
  const basic = withoutSettings(descriptor);
  const projected = projectAuthoredPort(basic);
  const unsupported = unknownDescriptorFields(projected, inspector.portSchema);
  if (unsupported.length)
    throw new Error(
      `Unsupported native integration fields: ${unsupported.join(", ")}. Remove them or use an implemented Portcove contract.`,
    );
  const proposal = (replacement: AuthoredPort) => {
    // Settings capability validation is local to this proposal; another entry's
    // optional declaration cannot force a basic-only inspector to claim it.
    const context = records
      .filter((record) => record.listing.id !== replacement.listing.id)
      .map(withoutSettings);
    return Buffer.from(
      JSON.stringify(assembleCatalogRecords(shared, [...context, replacement]).catalog),
    );
  };
  const basicBytes = proposal(basic);
  const basicReceipt = inspector.inspect("basic", basicBytes);
  let selected = basicBytes;
  let settings: {
    status: "absent" | "validated-proposal" | "unsupported";
    diagnostic?: string;
    receipt?: ProposalReceipt;
  } = { status: "absent" };
  if (Object.hasOwn(descriptor.integration, "game_settings")) {
    if (
      !isRecord(inspector.portSchema.properties) ||
      !Object.hasOwn(inspector.portSchema.properties, "game_settings")
    ) {
      settings = {
        status: "unsupported",
        diagnostic:
          "This captured Core reader does not implement game_settings; basic integration remains valid.",
      };
    } else {
      try {
        const fields = unknownDescriptorFields(
          projectAuthoredPort(descriptor),
          inspector.portSchema,
        );
        if (fields.length) throw new Error(`Unsupported settings fields: ${fields.join(", ")}.`);
        const settingsBytes = proposal(descriptor);
        const receipt = inspector.inspect("settings", settingsBytes);
        settings = { status: "validated-proposal", receipt };
        selected = settingsBytes;
      } catch (error) {
        settings = { status: "unsupported", diagnostic: errorMessage(error) };
      }
    }
  }
  return {
    proposal: selected,
    report: {
      format_version: 1,
      descriptor_sha256: sha256(bytes),
      port_id: descriptor.listing.id,
      validator_artifact_sha256: inspector.artifactSha256,
      basic: { status: "validated-proposal", receipt: basicReceipt },
      settings,
      scope:
        "Inert declaration validation only; no admission, installation, command execution, configuration access or publication authority.",
    },
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      "validator-cli": { type: "string" },
      "output-dir": { type: "string" },
      "catalog-root": { type: "string" },
    },
  });
  if (
    positionals.length !== 2 ||
    positionals[0] !== "validate" ||
    !values["validator-cli"] ||
    !values["output-dir"]
  )
    throw new Error(
      "usage: port-descriptor.mts validate FILE --validator-cli CORE_CLI --output-dir NEW_DIRECTORY [--catalog-root DIRECTORY]",
    );
  const input = path.resolve(positionals[1]!);
  const { bytes } = await readBoundedEvidenceFile(input, maximumDescriptorBytes);
  const output = path.resolve(values["output-dir"]);
  mkdirSync(output);
  const scratch = path.join(output, "inspector");
  mkdirSync(scratch);
  const captured = coreProposalInspector(values["validator-cli"], scratch);
  const schema = spawnSync(
    captured.artifact,
    ["--json", "--non-interactive", "schema", "export", "--contract", "input"],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PORTCOVE_LIBRARY: undefined },
    },
  );
  writeFileSync(
    path.join(output, "schema-process.json"),
    JSON.stringify(
      { status: schema.status, error: schema.error?.message, stderr: schema.stderr?.slice(-8192) },
      null,
      2,
    ),
  );
  if (schema.error || schema.status !== 0)
    throw new Error(
      "Captured Core schema export failed; retained schema-process.json has the reason.",
    );
  const envelope: unknown = JSON.parse(schema.stdout);
  if (!isRecord(envelope) || !isRecord(envelope.data) || !isRecord(envelope.data.port))
    throw new Error("Captured Core did not provide its port input schema.");
  writeFileSync(path.join(output, "core-input-schema.json"), schema.stdout);
  const catalogRoot = path.resolve(
    values["catalog-root"] ?? path.join(root, "crates/portcove-core/catalog"),
  );
  const context = readCatalogSource(catalogRoot);
  const sharedInput = await readBoundedEvidenceFile(
    path.join(catalogRoot, "catalog-shared.json"),
    8 * 1024 * 1024,
  );
  const shared = parseCatalogSource(sharedInput.bytes.toString("utf8"));
  const result = inspectPortDescriptor({
    bytes,
    records: context.records,
    shared,
    inspector: {
      portSchema: envelope.data.port,
      artifactSha256: sha256(readFileSync(captured.artifact)),
      inspect: captured.inspect,
    },
  });
  writeFileSync(path.join(output, "catalog-proposal.json"), result.proposal, { flag: "wx" });
  writeFileSync(
    path.join(output, "descriptor-report.json"),
    JSON.stringify(result.report, null, 2) + "\n",
    { flag: "wx" },
  );
  process.stdout.write(JSON.stringify(result.report) + "\n");
  if (result.report.settings.status === "unsupported") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
