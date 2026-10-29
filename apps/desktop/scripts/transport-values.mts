import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { TransportOutputs } from "../src/transport-types.generated.js";
import { isRecord } from "../../../scripts/runtime-values.mts";

// Only maintained local Rust exports are compiled. No remote schema loader,
// coercion, default insertion, or removal of properties is enabled.
const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  // Schemars numeric formats are annotations; exported type/minimum/maximum
  // keywords own their constraints. Unrecognized future formats still fail.
  formats: {
    int32: true,
    int64: true,
    uint: true,
    uint32: true,
    uint64: true,
    uint8: true,
    uint16: true,
  },
});
function readSchemas(name: string) {
  const value: unknown = JSON.parse(
    readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"),
  );
  if (!isRecord(value) || !Object.values(value).every(isRecord))
    throw new Error("Rust transport schema inventory is malformed");
  return value;
}
const schemas = new Map(Object.entries(readSchemas("transport-schemas.generated.json")));
for (const [key, schema] of Object.entries(readSchemas("transport-host-output.generated.json"))) {
  const contract = `desktop_${key}`;
  if (schemas.has(contract)) throw new Error(`Desktop schema key collides with core: ${contract}`);
  schemas.set(contract, schema);
}
const validators = new Map<string, ValidateFunction<unknown>>();
function validator(contract: string): ValidateFunction<unknown> {
  const previous = validators.get(contract);
  if (previous) return previous;
  const schema = schemas.get(contract);
  if (!isRecord(schema)) throw new Error(`Missing Rust transport schema: ${contract}`);
  const compiled = ajv.compile<unknown>(schema);
  validators.set(contract, compiled);
  return compiled;
}
function assertTransportValue<Contract extends keyof TransportOutputs>(
  contract: Contract,
  value: unknown,
): asserts value is TransportOutputs[Contract] {
  const validate = validator(contract);
  if (!validate(value))
    throw new Error(`Invalid ${contract} transport value: ${ajv.errorsText(validate.errors)}`);
}
/** Validate external observations against their Rust-owned contract before using generated types. */
export function transportValue<Contract extends keyof TransportOutputs>(
  contract: Contract,
  value: unknown,
): TransportOutputs[Contract] {
  assertTransportValue(contract, value);
  return value;
}
export function transportValues<Contract extends keyof TransportOutputs>(
  contract: Contract,
  value: unknown,
): TransportOutputs[Contract][] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${contract} transport collection`);
  const entries: unknown[] = value;
  return entries.map((entry) => transportValue(contract, entry));
}

/** Check loader/schema compatibility for the complete current export inventory. */
export function checkTransportSchemas() {
  for (const contract of schemas.keys()) validator(contract);
  return schemas.size;
}
