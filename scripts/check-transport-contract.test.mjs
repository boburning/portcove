import assert from "node:assert/strict";
import test from "node:test";
import { checkTransportContract } from "./check-transport-contract.mjs";

const schemas = {
  operation_event: { properties: {}, oneOf: [{ properties: { type: { const: "progress" } } }] },
  activity: { $defs: { ActivityOperation: { enum: ["install", "remove_source"] } } },
};

test("enum drift is rejected without spawning Cargo", () => {
  const source = 'export type ActivityOperation = "install" | "remove_source";';
  assert.ok(!checkTransportContract(schemas, source).some(item => item.startsWith("ActivityOperation")));
  assert.ok(checkTransportContract(schemas, source.replace(' | "remove_source"', '')).some(item => item.startsWith("ActivityOperation values differ")));
});

test("event aliases resolve references and cyclic aliases fail closed", () => {
  const source = 'export type Progress = "progress"; export type OperationEventType = Progress;';
  assert.ok(!checkTransportContract(schemas, source).some(item => item.startsWith("OperationEventType")));
  const cyclic = 'export type Progress = OperationEventType; export type OperationEventType = Progress;';
  assert.ok(checkTransportContract(schemas, cyclic).some(item => item.startsWith("OperationEventType values differ")));
});

test("missing interfaces and inconsistent Rust enum definitions are reported", () => {
  const conflict = { ...schemas, other: { $defs: { ActivityOperation: { enum: ["changed"] } } } };
  const failures = checkTransportContract(conflict, "");
  assert.ok(failures.includes("Rust schemas disagree about ActivityOperation"));
  assert.ok(failures.includes("catalog is missing its CatalogDocument contract"));
});
