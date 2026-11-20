import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "../../../scripts/runtime-values.mts";

const digest = /^[0-9a-f]{64}$/u;

function subject(value: unknown) {
  assert.ok(isRecord(value), "Expected an exact signed definition subject");
  const { stable_id, definition_revision, entry_sha256 } = value;
  assert.ok(typeof stable_id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stable_id));
  assert.ok(
    typeof definition_revision === "number" &&
      Number.isSafeInteger(definition_revision) &&
      definition_revision > 0,
  );
  assert.ok(
    typeof entry_sha256 === "string" && digest.test(entry_sha256),
    "Expected the exact signed entry digest",
  );
  return { stable_id, definition_revision, entry_sha256 };
}

export function automaticDefinitionExpectation(fixture: unknown) {
  assert.ok(isRecord(fixture) && fixture.schema_version === 2);
  const value = fixture.expectation;
  if (value === null) return null;
  assert.ok(isRecord(value), "Expected a bound automatic definition fixture or explicit null");
  const { release_version, root_sha256, index_sha256 } = value;
  assert.ok(
    typeof release_version === "string" && /^\d+\.\d+\.\d+-preview\.\d+$/u.test(release_version),
  );
  assert.ok(typeof root_sha256 === "string" && digest.test(root_sha256));
  assert.ok(typeof index_sha256 === "string" && digest.test(index_sha256));
  const requested = subject(value.requested);
  const coexisting = subject(value.coexisting);
  assert.notEqual(requested.stable_id, coexisting.stable_id, "Expected distinct signed subjects");
  return { release_version, root_sha256, index_sha256, requested, coexisting };
}

type Expectation = NonNullable<ReturnType<typeof automaticDefinitionExpectation>>;

export function verifyRetainedAutomaticDefinitions(file: string, expected: Expectation) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const read = database.prepare(`SELECT active_json, historical_only
      FROM definition_subject_selection WHERE namespace = 'official' AND stable_id = ?`);
    const verify = ({ stable_id, definition_revision, entry_sha256 }: Expectation["requested"]) => {
      const row = read.get(stable_id);
      assert.ok(
        row && typeof row.active_json === "string",
        `Missing official selection for ${stable_id}`,
      );
      assert.equal(row.historical_only, 0, `${stable_id} must be active`);
      const stored: unknown = JSON.parse(row.active_json);
      assert.ok(isRecord(stored) && isRecord(stored.provenance) && isRecord(stored.snapshot));
      assert.equal(stored.namespace, "official", stable_id);
      assert.equal(stored.stable_id, stable_id, "Selection must retain its exact stable id");
      assert.equal(
        stored.definition_revision,
        definition_revision,
        `${stable_id} publisher revision`,
      );
      assert.equal(
        stored.repository_root_sha256,
        expected.root_sha256,
        `${stable_id} trusted root`,
      );
      assert.equal(
        stored.provenance.root_sha256,
        expected.root_sha256,
        `${stable_id} provenance root`,
      );
      assert.equal(
        stored.provenance.index_sha256,
        expected.index_sha256,
        `${stable_id} provenance index`,
      );
      assert.equal(stored.snapshot.namespace, "official", stable_id);
      assert.equal(
        stored.snapshot.stable_id,
        stable_id,
        "Snapshot must retain its exact stable id",
      );
      assert.ok(
        typeof stored.snapshot.index_json === "string",
        `${stable_id} retained index bytes`,
      );
      const retainedIndex = createHash("sha256").update(stored.snapshot.index_json).digest("hex");
      assert.equal(retainedIndex, expected.index_sha256, `${stable_id} retained index digest`);
      assert.ok(
        typeof stored.snapshot.entry_json === "string",
        `${stable_id} retained entry bytes`,
      );
      const retainedEntry = createHash("sha256").update(stored.snapshot.entry_json).digest("hex");
      assert.equal(retainedEntry, entry_sha256, `${stable_id} retained entry digest`);
      return {
        namespace: "official",
        stable_id,
        definition_revision,
        index_sha256: retainedIndex,
        entry_sha256: retainedEntry,
      };
    };
    return { requested: verify(expected.requested), coexisting: verify(expected.coexisting) };
  } finally {
    database.close();
  }
}
