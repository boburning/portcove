import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  operationalReaderProofScope,
  requireOperationalReaderCapabilities,
  requireOperationalReaderProof,
} from "./catalog-definition-reader-gate.mts";
import { operationalReaderRequirements } from "./catalog-definition-requirements.mts";

const strengthenedReaderSubjects = (...args: Parameters<typeof operationalReaderRequirements>) =>
  operationalReaderRequirements(...args).subjects;

type Requirements = {
  definitionSchema?: number;
  projectionSchema?: number;
  policySchema?: number;
  policyDecisionSchema?: number;
  launchSchema?: number;
  features?: string[];
  capabilities?: { template: string; minimum_version: number; maximum_version: number }[];
};

function bundle(subjects: Record<string, Requirements>) {
  const files = new Map<string, Buffer>();
  const write = (target: string, value: unknown) => {
    files.set(target, Buffer.from(JSON.stringify(value)));
    return target;
  };
  const definitions = Object.entries(subjects).map(([stable_id, requirement]) => {
    const execution_contract = write(`sha256/${stable_id}-execution.json`, {
      contract_schema: requirement.projectionSchema ?? 1,
    });
    const target = write(`sha256/${stable_id}.json`, {
      definition_schema: requirement.definitionSchema ?? 1,
      required_features: requirement.features,
      required_capabilities: requirement.capabilities ?? [],
      execution_contract,
    });
    write(`policy/official/${stable_id}.json`, {
      policy_schema: requirement.policySchema ?? 1,
      decision_schema: requirement.policyDecisionSchema,
    });
    if (requirement.launchSchema)
      write(`policy/official/${stable_id}.launch.json`, {
        assessment_schema: requirement.launchSchema,
      });
    return { namespace: "official", stable_id, target };
  });
  write("definitions/index.json", { definitions });
  return files;
}

function authoredBundle() {
  const root = path.join(import.meta.dirname, "../release/catalog-publication/bundle");
  return new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return [path.relative(root, full).split(path.sep).join("/"), readFileSync(full)] as const;
      }),
  );
}

void test("unchanged operational authorship and separate listing carrier changes do not require another reader", () => {
  const files = authoredBundle();
  const updated = new Map(files);
  updated.set("policy/official/catalog.listings.compact.json", Buffer.from("separate target"));
  assert.deepEqual(strengthenedReaderSubjects(files, updated), []);
});

void test("a new named subject and stronger existing operational requirements require proof", () => {
  const previous = bundle({
    capability: { capabilities: [{ template: "archive", minimum_version: 1, maximum_version: 3 }] },
    feature: { definitionSchema: 4, features: ["existing"] },
    decision: {},
    launch: {},
    policy: {},
    projection: {},
    schema: {},
  });
  const next = bundle({
    new: { definitionSchema: 4 },
    capability: { capabilities: [{ template: "archive", minimum_version: 1, maximum_version: 2 }] },
    feature: { definitionSchema: 4, features: ["existing", "added"] },
    decision: { policyDecisionSchema: 2 },
    launch: { launchSchema: 1 },
    policy: { policySchema: 2 },
    projection: { projectionSchema: 2 },
    schema: { definitionSchema: 2 },
  });
  assert.deepEqual(strengthenedReaderSubjects(previous, next), [
    "capability",
    "decision",
    "feature",
    "launch",
    "new",
    "policy",
    "projection",
    "schema",
  ]);
});

void test("legacy additions require one known baseline and widening or removal needs no proof", () => {
  const previous = bundle({
    one: { capabilities: [{ template: "one", minimum_version: 2, maximum_version: 3 }] },
    two: { capabilities: [{ template: "two", minimum_version: 1, maximum_version: 3 }] },
  });
  const one = { template: "one", minimum_version: 1, maximum_version: 3 };
  const two = { template: "two", minimum_version: 1, maximum_version: 3 };
  assert.deepEqual(
    strengthenedReaderSubjects(
      previous,
      bundle({
        one: { capabilities: [one] },
        equivalent: { capabilities: [two] },
        combined: { capabilities: [one, two] },
      }),
    ),
    ["combined"],
  );
  assert.deepEqual(strengthenedReaderSubjects(null, bundle({ legacy: {} })), []);
  assert.deepEqual(strengthenedReaderSubjects(null, bundle({ named: { definitionSchema: 4 } })), [
    "named",
  ]);
});

void test("malformed input cannot silently bypass proof", () => {
  const next = bundle({ named: { definitionSchema: 4, features: ["duplicate", "duplicate"] } });
  assert.throws(
    () => strengthenedReaderSubjects(null, next),
    /duplicate named catalog reader feature/u,
  );
  next.delete("policy/official/named.json");
  assert.throws(() => strengthenedReaderSubjects(null, next), /target is absent/u);
});

void test("an explicit policy decision schema cannot bootstrap silently", () => {
  assert.deepEqual(
    strengthenedReaderSubjects(null, bundle({ decision: { policyDecisionSchema: 2 } })),
    ["decision"],
  );
  assert.throws(
    () => strengthenedReaderSubjects(null, bundle({ decision: { policyDecisionSchema: 1 } })),
    /invalid explicit catalog policy decision schema/iu,
  );
});

void test("reader features include both sides of the inspected transition", () => {
  const prior = bundle({ item: { definitionSchema: 4, features: ["older"] } });
  const next = bundle({
    item: { definitionSchema: 4, features: ["newer"], policyDecisionSchema: 2 },
  });
  assert.deepEqual(operationalReaderRequirements(prior, next), {
    subjects: ["item"],
    features: ["catalog.policy-decision-v2", "newer", "older"],
  });
});

void test("proof must bind the signed operational transition, reader release and both feature sets", () => {
  const prior = bundle({ item: {} });
  const next = bundle({ item: { policyDecisionSchema: 2 } });
  const scope = operationalReaderProofScope(prior, next);
  assert.ok(scope);
  assert.equal(operationalReaderProofScope(prior, prior), null);
  assert.throws(() => operationalReaderProofScope(null, next), /authenticated prior catalog/u);
  const reader = {
    feed_commit: "a".repeat(40),
    source: "b".repeat(40),
    tag_object: "c".repeat(40),
    release_id: 123,
    archive_bytes: 789,
    archive_sha256: "d".repeat(64),
    checksum_sha256: "e".repeat(64),
    version: "0.1.0-preview.18",
    tag: "nightly-0.1.0-preview.18",
  };
  const receipt = { scope, reader, reader_sha256: "f".repeat(64) };
  assert.deepEqual(requireOperationalReaderProof(scope, receipt), reader);
  assert.throws(
    () => requireOperationalReaderProof(scope, { ...receipt, reader: { version: reader.version } }),
    /release identity/u,
  );
  const changed = operationalReaderProofScope(
    prior,
    bundle({ item: { policyDecisionSchema: 2, launchSchema: 1 } }),
  );
  assert.ok(changed);
  assert.throws(
    () => requireOperationalReaderProof(changed, receipt),
    /differs from the signed transition/u,
  );

  const envelope = (definition_features: string[]) =>
    JSON.stringify({
      ok: true,
      error: null,
      command: "capabilities",
      data: { product: "Portcove", product_version: reader.version, definition_features },
    });
  assert.doesNotThrow(() =>
    requireOperationalReaderCapabilities(
      envelope(scope.features),
      "",
      reader.version,
      scope.features,
    ),
  );
  assert.throws(
    () => requireOperationalReaderCapabilities(envelope([]), "", reader.version, scope.features),
    /required operational features/u,
  );
  assert.throws(
    () =>
      requireOperationalReaderCapabilities(
        envelope(scope.features),
        "",
        "0.1.0-preview.12",
        scope.features,
      ),
    /product and version/u,
  );
});

void test("publication entry points renew unchanged inputs and stop a newly strengthened assembly without proof", (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), "operational-reader-gate-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const write = (name: string, bytes: Buffer | string) => {
    const file = path.join(work, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const shaRow = (target: string, bytes: Buffer) => ({
    target,
    bytes: bytes.length,
    sha256: hash(bytes),
  });
  const published = (root: string, files: ReadonlyMap<string, Buffer>) => {
    const rows = new Map<string, Buffer>();
    const addJSON = (name: string, value: unknown) =>
      rows.set(name, Buffer.from(JSON.stringify(value)));
    const roles = [
      Object.create(null) as Record<string, unknown>,
      Object.create(null) as Record<string, unknown>,
    ];
    for (const [name, bytes] of files) {
      roles[name.startsWith("policy/") ? 1 : 0]![name] = { hashes: { sha256: hash(bytes) } };
      rows.set(`targets/${hash(bytes)}.${name}`, bytes);
    }
    addJSON("metadata/timestamp.json", {
      signed: { version: 1, meta: { "snapshot.json": { version: 1 } } },
    });
    addJSON("metadata/1.snapshot.json", {
      signed: {
        meta: {
          "official-definitions.json": { version: 1 },
          "official-policy.json": { version: 1 },
        },
      },
    });
    addJSON("metadata/1.official-definitions.json", { signed: { targets: roles[0] } });
    addJSON("metadata/1.official-policy.json", { signed: { targets: roles[1] } });
    for (const [name, bytes] of rows) write(`${root}/${name}`, bytes);
    const inventory = [...rows]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, bytes]) => shaRow(name, bytes));
    write(
      "assembly-report.json",
      JSON.stringify({
        schema_version: 1,
        authority: "none",
        files: inventory,
        timestamp_sha256: hash(rows.get("metadata/timestamp.json")!),
        repository_sha256: hash(JSON.stringify(inventory)),
      }),
    );
  };
  const script = fileURLToPath(new URL("./catalog-definition-reader-gate.mts", import.meta.url));
  const gate = (mode: string) =>
    execFileSync(process.execPath, [script, mode, work, work], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30000,
    });

  const files = authoredBundle();
  for (const [name, bytes] of files) write(`bundle/${name}`, bytes);
  write(
    "inspection.json",
    JSON.stringify({ files: [...files].map(([name, bytes]) => shaRow(name, bytes)) }),
  );
  published("prior", files);
  published("repository", files);
  assert.doesNotThrow(() => gate("prepare"));
  assert.doesNotThrow(() => gate("recheck"));

  const policy = "policy/official/chameleon-twist-jp-recompiled.json";
  const staged = new Map(files);
  const current: unknown = JSON.parse(files.get(policy)!.toString());
  assert.ok(current && typeof current === "object");
  staged.set(policy, Buffer.from(JSON.stringify({ ...current, decision_schema: 2 })));
  published("repository", staged);
  assert.throws(() => gate("recheck"), /operational-reader-proof\.json/u);
});
