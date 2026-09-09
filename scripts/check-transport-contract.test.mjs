import assert from "node:assert/strict";
import test from "node:test";
import { checkTransportContract } from "./check-transport-contract.mjs";
import { renderTransportSchemas } from "./transport-schemas.mjs";

const schemas = {
  response: {
    type: "object", required: ["items"],
    properties: { items: { type: "array", items: { $ref: "#/$defs/Item" } } },
    $defs: { Item: { type: "object", required: ["count"], properties: { count: { type: ["integer", "null"] }, state: { enum: ["ready", "held"] } } } },
  },
};

test("the complete contract is canonical and line-ending independent", () => {
  const rendered = renderTransportSchemas(schemas);
  assert.deepEqual(checkTransportContract(schemas, rendered.replaceAll("\n", "\r\n")), []);
  const reordered = { response: Object.fromEntries(Object.entries(schemas.response).reverse()) };
  assert.equal(renderTransportSchemas(reordered), rendered);
});

test("nested types, nullability, required presence, arrays and union drift fail closed", () => {
  for (const mutate of [
    schema => { schema.$defs.Item.properties.count.type = ["string", "null"]; },
    schema => { schema.$defs.Item.properties.count.type = "integer"; },
    schema => { schema.$defs.Item.required = []; },
    schema => { schema.properties.items.type = "object"; },
    schema => { schema.$defs.Item.properties.state.enum.push("unknown"); },
  ]) {
    const changed = structuredClone(schemas);
    mutate(changed.response);
    assert.equal(checkTransportContract(schemas, renderTransportSchemas(changed)).length, 1);
  }
});

test("invalid or absent schema inventories cannot generate an empty passing contract", () => {
  for (const invalid of [null, [], {}, { response: null }]) assert.throws(() => renderTransportSchemas(invalid), /named JSON schemas/);
  assert.equal(checkTransportContract(schemas, "").length, 1);
});
