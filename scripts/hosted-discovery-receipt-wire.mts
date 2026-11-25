import { isRecord } from "./runtime-values.mts";

// These positions are the persistent tuple-v1 schema. Never reorder them.
const planFields = [
  "body_sha256",
  "evidence_sha256",
  "primary",
  "candidate_index",
  "port_key",
  "location",
  "amendment",
];
const primaryFields = ["repository_id", "readme_commit", "readme_blob", "release_fingerprint"];
const deliveryFields = [
  "status",
  "created_issue",
  "item_id",
  "existing",
  "canonical_issue",
  "created_comment",
  "observation_sha256",
  "fields",
  "doctor",
  "hold",
];
const doctorFields = [
  "status",
  "coverage",
  "global_health",
  "issues",
  "checked_issue_count",
  "receipt_sha256",
];

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Malformed hosted receipt wire object");
  return value;
}

function pack(value: unknown, fields: readonly string[]) {
  const row = record(value);
  // Historical extensions must survive; an object remains a lossless fallback.
  if (Object.keys(row).some((key) => row[key] !== undefined && !fields.includes(key))) return row;
  let mask = 0;
  const values: unknown[] = [];
  fields.forEach((key, index) => {
    if (Object.hasOwn(row, key) && row[key] !== undefined) {
      mask += 2 ** index;
      values.push(row[key]);
    }
  });
  return [mask, ...values];
}

function unpack(value: unknown, fields: readonly string[]) {
  if (!Array.isArray(value)) return record(value);
  const mask: unknown = value[0];
  if (
    !Number.isSafeInteger(mask) ||
    typeof mask !== "number" ||
    mask < 0 ||
    mask >= 2 ** fields.length
  )
    throw new Error("Malformed hosted receipt wire mask");
  const keys = fields.filter((_, index) => (mask & (2 ** index)) !== 0);
  if (value.length !== keys.length + 1) throw new Error("Malformed hosted receipt wire tuple");
  return Object.fromEntries(keys.map((key, index) => [key, value[index + 1]]));
}

export function compactHostedReceiptDelivery(value: unknown) {
  const row = { ...record(value) };
  if (row.doctor !== undefined && row.doctor !== null) row.doctor = pack(row.doctor, doctorFields);
  return pack(row, deliveryFields);
}

export function compactHostedReceiptWire(value: unknown) {
  const receipt = record(value);
  if (!Array.isArray(receipt.plan) || !Array.isArray(receipt.delivery))
    throw new Error("Malformed hosted receipt wire coverage");
  return {
    ...receipt,
    wire_encoding: "tuple-v1",
    plan: receipt.plan.map((value) => {
      const row = { ...record(value) };
      if (row.primary !== undefined && row.primary !== null)
        row.primary = pack(row.primary, primaryFields);
      return pack(row, planFields);
    }),
    delivery: receipt.delivery.map(compactHostedReceiptDelivery),
  };
}

export function expandHostedReceiptWire(value: unknown) {
  const receipt = record(value);
  if (receipt.wire_encoding === undefined) return receipt;
  if (receipt.wire_encoding !== "tuple-v1") throw new Error("Unknown hosted receipt wire encoding");
  if (!Array.isArray(receipt.plan) || !Array.isArray(receipt.delivery))
    throw new Error("Malformed hosted receipt wire coverage");
  const { wire_encoding: _encoding, ...rest } = receipt;
  return {
    ...rest,
    plan: receipt.plan.map((value) => {
      const row = { ...unpack(value, planFields) };
      if (row.primary !== undefined && row.primary !== null)
        row.primary = unpack(row.primary, primaryFields);
      return row;
    }),
    delivery: receipt.delivery.map((value) => {
      const row = { ...unpack(value, deliveryFields) };
      if (row.doctor !== undefined && row.doctor !== null)
        row.doctor = unpack(row.doctor, doctorFields);
      return row;
    }),
  };
}
