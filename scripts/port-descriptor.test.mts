import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectPortDescriptor, unknownDescriptorFields } from "./port-descriptor.mts";
import { parseCatalogSource, readCatalogSource } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const catalogRoot = fileURLToPath(new URL("../crates/portcove-core/catalog", import.meta.url));
const context = readCatalogSource(catalogRoot);
const shared = parseCatalogSource(
  readFileSync(
    new URL("../crates/portcove-core/catalog/catalog-shared.json", import.meta.url),
    "utf8",
  ),
);
const sample = (file: string) =>
  readFileSync(new URL(`../examples/integrations/${file}`, import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// These controlled schema/receipt doubles exercise translation only. The
// documented CLI route separately executes a captured compiled Core inspector.
const properties = Object.fromEntries(
  [...new Set(context.catalog.ports.flatMap((port) => Object.keys(port))), "game_settings"].map(
    (key) => [key, {}],
  ),
);
function inspector(supportsSettings = true) {
  const fields = structuredClone(properties);
  if (!supportsSettings) delete fields.game_settings;
  const seen: { name: string; value: unknown }[] = [];
  return {
    seen,
    artifactSha256: "a".repeat(64),
    portSchema: { type: "object", properties: fields },
    inspect(name: string, bytes: Buffer) {
      seen.push({ name, value: JSON.parse(bytes.toString("utf8")) as unknown });
      return {
        format_version: 1 as const,
        input_sha256: hash(bytes),
        input_bytes: bytes.length,
        ports: [],
        validator_artifact_sha256: "a".repeat(64),
      };
    },
  };
}

void test("both real native descriptors use the same projection and settings inspection route", () => {
  for (const file of ["shipwright/portcove.json", "golden-balloon/portcove.json"]) {
    const compiled = inspector();
    const bytes = sample(file);
    const result = inspectPortDescriptor({
      bytes,
      records: context.records,
      shared,
      inspector: compiled,
    });
    assert.equal(result.report.basic.status, "validated-proposal");
    assert.equal(result.report.settings.status, "validated-proposal");
    assert.deepEqual(
      compiled.seen.map((row) => row.name),
      ["basic", "settings"],
    );
    assert.equal(result.report.descriptor_sha256, hash(bytes));
    for (const [index, observation] of compiled.seen.entries()) {
      assert.ok(isRecord(observation.value) && Array.isArray(observation.value.ports));
      const own: unknown = observation.value.ports.find(
        (port: unknown) => isRecord(port) && port.id === result.report.port_id,
      );
      assert.ok(isRecord(own));
      assert.equal(Object.hasOwn(own, "game_settings"), index === 1);
    }
    const proposal: unknown = JSON.parse(result.proposal.toString("utf8"));
    assert.ok(isRecord(proposal) && Array.isArray(proposal.ports));
    assert.equal(
      proposal.ports.filter((port: unknown) => isRecord(port) && port.id === result.report.port_id)
        .length,
      1,
    );
  }
});

void test("basic launch does not require settings and older Core readers never claim the optional capability", () => {
  const basic = inspector(false);
  const result = inspectPortDescriptor({
    bytes: sample("shipwright/basic.portcove.json"),
    records: context.records,
    shared,
    inspector: basic,
  });
  assert.equal(result.report.settings.status, "absent");
  assert.deepEqual(
    basic.seen.map((row) => row.name),
    ["basic"],
  );
  const old = inspector(false);
  const partial = inspectPortDescriptor({
    bytes: sample("golden-balloon/portcove.json"),
    records: context.records,
    shared,
    inspector: old,
  });
  assert.equal(partial.report.basic.status, "validated-proposal");
  assert.equal(partial.report.settings.status, "unsupported");
  assert.deepEqual(
    old.seen.map((row) => row.name),
    ["basic"],
  );
  const plain: unknown = JSON.parse(partial.proposal.toString("utf8"));
  assert.ok(isRecord(plain) && Array.isArray(plain.ports));
  assert.equal(
    plain.ports.some((port: unknown) => isRecord(port) && Object.hasOwn(port, "game_settings")),
    false,
  );
});

void test("a Core settings refusal retains useful validated basic behavior without claiming full support", () => {
  const compiled = inspector();
  const inspect = compiled.inspect;
  compiled.inspect = (name, bytes) => {
    if (name === "settings") throw new Error("game_settings.files: unsafe configuration path");
    return inspect(name, bytes);
  };
  const result = inspectPortDescriptor({
    bytes: sample("golden-balloon/portcove.json"),
    records: context.records,
    shared,
    inspector: compiled,
  });
  assert.equal(result.report.basic.status, "validated-proposal");
  assert.equal(result.report.settings.status, "unsupported");
  assert.match(result.report.settings.diagnostic!, /unsafe configuration path/u);
});

void test("descriptor parsing refuses duplicate JSON, unknown executable fields and non-native schemas", () => {
  const compiled = inspector();
  for (const bytes of [
    Buffer.from('{"format_version":1,"format_version":2}'),
    Buffer.from('{"format":1,"game":{"kind":"rom"},"start":{"program":"run.exe"}}'),
  ])
    assert.throws(() =>
      inspectPortDescriptor({ bytes, records: context.records, shared, inspector: compiled }),
    );
  const source = JSON.parse(sample("shipwright/basic.portcove.json").toString("utf8")) as {
    integration: Record<string, unknown>;
  };
  source.integration.prepare_program = "untrusted.exe";
  assert.throws(
    () =>
      inspectPortDescriptor({
        bytes: Buffer.from(JSON.stringify(source)),
        records: context.records,
        shared,
        inspector: compiled,
      }),
    /integration.prepare_program/u,
  );
  assert.equal(compiled.seen.length, 0);
});

void test("unknown-field inspection follows captured Core references and map shapes without defining another port schema", () => {
  const schema = {
    type: "object",
    properties: {
      release: { $ref: "#/$defs/Release" },
      environment: { type: "object", additionalProperties: { type: "string" } },
    },
    $defs: { Release: { type: "object", properties: { repository: { type: "string" } } } },
  };
  assert.deepEqual(
    unknownDescriptorFields(
      {
        release: { repository: "author/port", command: "not-allowed" },
        environment: { REVIEWED: "." },
      },
      schema,
    ),
    ["integration.release.command"],
  );
});
