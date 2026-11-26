import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { strengthenedReaderSubjects } from "./catalog-definition-requirements.mts";

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

test("unchanged operational authorship and separate listing carrier changes do not require another reader", () => {
  const root = path.join(import.meta.dirname, "../release/catalog-publication/bundle");
  const files = new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const full = path.join(entry.parentPath, entry.name);
        return [path.relative(root, full).split(path.sep).join("/"), readFileSync(full)];
      }),
  );
  const updated = new Map(files);
  updated.set("policy/official/catalog.listings.compact.json", Buffer.from("separate target"));
  assert.deepEqual(strengthenedReaderSubjects(files, updated), []);
});

test("a new named subject and stronger existing operational requirements require proof", () => {
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

test("legacy additions require one known baseline and widening or removal needs no proof", () => {
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

test("malformed input cannot silently bypass proof", () => {
  const next = bundle({ named: { definitionSchema: 4, features: ["duplicate", "duplicate"] } });
  assert.throws(
    () => strengthenedReaderSubjects(null, next),
    /duplicate named catalog reader feature/u,
  );
  next.delete("policy/official/named.json");
  assert.throws(() => strengthenedReaderSubjects(null, next), /target is absent/u);
});

test("an explicit policy decision schema cannot bootstrap silently", () => {
  assert.deepEqual(
    strengthenedReaderSubjects(null, bundle({ decision: { policyDecisionSchema: 2 } })),
    ["decision"],
  );
  assert.throws(
    () => strengthenedReaderSubjects(null, bundle({ decision: { policyDecisionSchema: 1 } })),
    /invalid explicit catalog policy decision schema/iu,
  );
});
