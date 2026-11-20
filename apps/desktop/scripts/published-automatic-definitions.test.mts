import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  automaticDefinitionExpectation,
  verifyRetainedAutomaticDefinitions,
} from "./published-automatic-definitions.mts";

const indexJson = '{"test_only":"retained index bytes"}';
const requestedEntry = '{"test_only":"requested entry bytes"}';
const coexistingEntry = '{"test_only":"coexisting entry bytes"}';
const fixture = {
  schema_version: 2,
  expectation: {
    release_version: "0.1.0-preview.909",
    root_sha256: "a".repeat(64),
    index_sha256: createHash("sha256").update(indexJson).digest("hex"),
    requested: {
      stable_id: "fixture-requested",
      definition_revision: 3,
      entry_sha256: createHash("sha256").update(requestedEntry).digest("hex"),
    },
    coexisting: {
      stable_id: "fixture-coexisting",
      definition_revision: 7,
      entry_sha256: createHash("sha256").update(coexistingEntry).digest("hex"),
    },
  },
};

test("published automatic definition expectations are disabled until bound", () => {
  assert.equal(automaticDefinitionExpectation({ schema_version: 2, expectation: null }), null);
  assert.deepEqual(automaticDefinitionExpectation(fixture), fixture.expectation);
  assert.throws(() => automaticDefinitionExpectation({ schema_version: 2 }));
  assert.throws(() => automaticDefinitionExpectation({ schema_version: 1 }));
  assert.throws(
    () =>
      automaticDefinitionExpectation({
        ...fixture,
        expectation: {
          ...fixture.expectation,
          requested: { stable_id: fixture.expectation.requested.stable_id, definition_revision: 3 },
        },
      }),
    /exact signed entry digest/u,
  );
  assert.throws(
    () =>
      automaticDefinitionExpectation({
        ...fixture,
        expectation: { ...fixture.expectation, coexisting: fixture.expectation.requested },
      }),
    /distinct signed subjects/u,
  );
});

function syntheticSelection(
  { stable_id, definition_revision }: typeof fixture.expectation.requested,
  entry_json: string,
) {
  return {
    namespace: "official",
    stable_id,
    definition_revision,
    repository_root_sha256: fixture.expectation.root_sha256,
    provenance: {
      root_sha256: fixture.expectation.root_sha256,
      index_sha256: fixture.expectation.index_sha256,
    },
    snapshot: { namespace: "official", stable_id, index_json: indexJson, entry_json },
  };
}

test("post-close read requires both active selections from the exact retained official index and entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-automatic-definition-test-"));
  t.after(() => rm(root, { recursive: true }));
  const file = path.join(root, "fixture.sqlite3");
  const requested = syntheticSelection(fixture.expectation.requested, requestedEntry);
  const coexisting = syntheticSelection(fixture.expectation.coexisting, coexistingEntry);
  const create = new DatabaseSync(file);
  try {
    create.exec(`CREATE TABLE definition_subject_selection (
      namespace TEXT NOT NULL, stable_id TEXT NOT NULL, selected_revision INTEGER NOT NULL,
      active_json TEXT NOT NULL, historical_only INTEGER NOT NULL, PRIMARY KEY(namespace, stable_id)
    )`);
    const insert = create.prepare(
      "INSERT INTO definition_subject_selection VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("official", requested.stable_id, 20, JSON.stringify(requested), 0);
    insert.run("official", coexisting.stable_id, 21, JSON.stringify(coexisting), 0);
  } finally {
    create.close();
  }
  const verify = () => verifyRetainedAutomaticDefinitions(file, fixture.expectation);
  const before = await readFile(file);
  assert.deepEqual(verify(), {
    requested: {
      namespace: "official",
      ...fixture.expectation.requested,
      index_sha256: fixture.expectation.index_sha256,
    },
    coexisting: {
      namespace: "official",
      ...fixture.expectation.coexisting,
      index_sha256: fixture.expectation.index_sha256,
    },
  });
  assert.deepEqual(await readFile(file), before);
  const setCoexisting = (row: typeof coexisting, historical: number, namespace = "official") => {
    const editFixture = new DatabaseSync(file);
    try {
      editFixture
        .prepare(`UPDATE definition_subject_selection SET
        active_json=?, historical_only=?, namespace=? WHERE stable_id=?`)
        .run(JSON.stringify(row), historical, namespace, coexisting.stable_id);
    } finally {
      editFixture.close();
    }
  };
  setCoexisting({ ...coexisting, definition_revision: 6 }, 0);
  assert.throws(verify, /publisher revision/u);
  setCoexisting(
    { ...coexisting, provenance: { ...coexisting.provenance, index_sha256: "b".repeat(64) } },
    0,
  );
  assert.throws(verify, /provenance index/u);
  setCoexisting({ ...coexisting, snapshot: { ...coexisting.snapshot, index_json: "{}" } }, 0);
  assert.throws(verify, /retained index digest/u);
  setCoexisting(
    { ...coexisting, snapshot: { ...coexisting.snapshot, entry_json: requestedEntry } },
    0,
  );
  assert.throws(verify, /retained entry digest/u);
  setCoexisting(coexisting, 1);
  assert.throws(verify, /must be active/u);
  setCoexisting(coexisting, 0, "unrelated");
  assert.throws(verify, /Missing official selection for fixture-coexisting/u);
});
