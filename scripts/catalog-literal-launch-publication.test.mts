import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  literalLaunchBehaviorChange,
  literalLaunchBundle,
  literalLaunchDraft,
  literalLaunchRollback,
} from "./catalog-literal-launch-publication.mts";

type Doc = Record<string, unknown>;
const indexTarget = "definitions/index.json";
const feature = "runtime.reviewed-package-and-launch-v1";
// Test subject only: an authored native GitHub port with a literal argument list.
const subjectId = "blacklabelhq-medievilrecomp";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const target = (bytes: Buffer) => `sha256/${hash(bytes)}.json`;
const parse = (bytes: Buffer | undefined) => {
  assert.ok(bytes);
  return JSON.parse(bytes.toString("utf8")) as Doc;
};

function authoredPort(): Doc {
  const catalog = JSON.parse(
    readFileSync(new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url), "utf8"),
  ) as { ports: Doc[] };
  const port = catalog.ports.find((candidate) => candidate.id === subjectId);
  assert.ok(port);
  return structuredClone(port);
}

/** A keyless prior bundle with one schema-1 subject and its managed bindings. */
function prior(port: Doc = authoredPort()) {
  const files = new Map<string, Buffer>();
  const projection = json({
    contract_schema: 1,
    representation: "catalog_projection",
    catalog: { schema_version: 2, source_catalog: {}, ports: [port] },
  });
  const entry = json({
    definition_schema: 1,
    namespace: "official",
    stable_id: port.id,
    revision: 3,
    required_capabilities: [{ template: "native-portable", minimum_version: 1 }],
    port,
    source_contracts: [target(projection)],
    execution_contract: target(projection),
    persistence_contract: target(projection),
    artifact_bindings: [],
    evidence_references: [],
  });
  const index = json({
    index_schema: 1,
    definitions: [
      { namespace: "official", stable_id: port.id, revision: 3, target: target(entry) },
    ],
    contents: [entry, projection]
      .map((bytes) => ({ target: target(bytes), sha256: hash(bytes), length: bytes.length }))
      .sort((a, b) => a.target.localeCompare(b.target)),
  });
  files.set(indexTarget, index);
  files.set(target(entry), entry);
  files.set(target(projection), projection);
  const policy = json({
    policy_schema: 3,
    namespace: "official",
    stable_id: port.id,
    grant_id: "fixture-grant",
    policy_revision: 4,
    decision: {
      status: "managed_github",
      index_sha256: hash(index),
      definition_revision: 3,
      definition_sha256: hash(entry),
      template: "native-portable",
    },
  });
  files.set(`policy/official/${String(port.id)}.json`, policy);
  files.set(
    `policy/official/${String(port.id)}.launch.json`,
    json({ stable_id: port.id, revision: 2, policy_sha256: hash(policy) }),
  );
  return files;
}

void test("a literal argument list moves into an equivalent per-platform contract", () => {
  const port = authoredPort();
  const draft = parse(literalLaunchDraft(prior(port), subjectId));
  assert.equal(draft.contract_schema, 3);
  const [moved] = (draft.catalog as { ports: Doc[] }).ports;
  assert.deepEqual(moved!.launch_arguments, []);
  assert.deepEqual(moved!.reviewed_launch_contract_v1, {
    launch: Object.fromEntries(
      (port.platforms as string[]).map((platform) => [
        platform,
        { arguments: port.launch_arguments },
      ]),
    ),
  });
  // Everything except the representation of the argument list is unchanged.
  const { launch_arguments: _before, ...unchanged } = port;
  const { launch_arguments: _after, reviewed_launch_contract_v1: _contract, ...remaining } = moved!;
  assert.deepEqual(remaining, unchanged);
  assert.equal(literalLaunchBehaviorChange(port), undefined);
});

void test("a subject whose launch behavior would change is refused", () => {
  const changes: [string, (port: Doc) => void][] = [
    ["managed_initialization", (port) => (port.managed_initialization = { kind: "fixture" })],
    ["external_profile_policy", (port) => (port.external_profile_policy = "doom3-linux-v1")],
    ["runtime_data_policy", (port) => (port.runtime_data_policy = { kind: "fixture" })],
    [
      "managed_shared_preferences",
      (port) => (port.managed_shared_preferences = { kind: "fixture" }),
    ],
    ["bundled_runtime", (port) => (port.bundled_runtime = { "windows-x86-64": {} })],
    [
      "release.managed_build",
      (port) => ((port.release as Doc).managed_build = { "windows-x86-64": {} }),
    ],
    [
      "release.user_prepared",
      (port) => ((port.release as Doc).user_prepared = { "windows-x86-64": {} }),
    ],
  ];
  for (const [field, change] of changes) {
    const port = authoredPort();
    change(port);
    assert.match(literalLaunchBehaviorChange(port) ?? "", new RegExp(field.replace(".", "\\.")));
    assert.throws(
      () => literalLaunchDraft(prior(port), subjectId),
      new RegExp(`would change launch behavior: .*${field.replace(".", "\\.")}`),
      field,
    );
  }
  // Empty declarations do not read the argument list.
  const empty = authoredPort();
  empty.bundled_runtime = {};
  (empty.release as Doc).managed_build = {};
  assert.equal(literalLaunchBehaviorChange(empty), undefined);
});

void test("only an exact literal native GitHub argument list can move", () => {
  const cases: ((port: Doc) => void)[] = [
    (port) => (port.launch_arguments = []),
    (port) => (port.launch_arguments = ["--ok", ""]),
    (port) => (port.launch_arguments = ["--bad\u0007"]),
    (port) => (port.launch_arguments = [{ path: "user_data" }]),
    (port) => (port.adapter = "staged-source-portable"),
    (port) => ((port.release as Doc).provider = "reviewed-forge"),
    (port) => (port.reviewed_launch_contract_v1 = {}),
  ];
  for (const change of cases) {
    const port = authoredPort();
    change(port);
    assert.throws(() => literalLaunchDraft(prior(port), subjectId), /can move/u);
  }
  assert.throws(() => literalLaunchDraft(prior(), "absent-subject"), /exact existing/u);
});

void test("binding requires the exact draft and valid legacy feature names", () => {
  const files = prior();
  const draft = literalLaunchDraft(files, subjectId);
  const changed = parse(draft);
  ((changed.catalog as { ports: Doc[] }).ports[0] as Doc).launch_arguments = ["--other"];
  assert.throws(
    () => literalLaunchBundle(files, subjectId, json(changed), []),
    /beyond the reviewed literal launch move/u,
  );
  for (const features of [[feature], ["dup.v1", "dup.v1"], ["Invalid Name"]])
    assert.throws(
      () => literalLaunchBundle(files, subjectId, draft, features),
      /invalid reviewed feature names/u,
    );
});

void test("a bound move and its rollback rebind the subject's policy and launch records", () => {
  const files = prior();
  const draft = literalLaunchDraft(files, subjectId);
  const bundle = literalLaunchBundle(files, subjectId, draft, ["native.package-layouts-v1"]);
  const index = parse(bundle.get(indexTarget));
  const [row] = index.definitions as Doc[];
  assert.equal(row!.revision, 4);
  const entry = parse(bundle.get(String(row!.target)));
  assert.equal(entry.definition_schema, 4);
  assert.deepEqual(entry.required_features, ["native.package-layouts-v1", feature]);
  assert.equal(entry.execution_contract, target(draft));
  const policyBytes = bundle.get(`policy/official/${subjectId}.json`);
  const decision = parse(policyBytes).decision as Doc;
  assert.equal(decision.index_sha256, hash(bundle.get(indexTarget)!));
  assert.equal(decision.definition_sha256, hash(bundle.get(String(row!.target))!));
  assert.equal(
    parse(bundle.get(`policy/official/${subjectId}.launch.json`)).policy_sha256,
    hash(policyBytes!),
  );

  const rollback = literalLaunchRollback(bundle, files, subjectId);
  const [rolled] = parse(rollback.get(indexTarget)).definitions as Doc[];
  assert.equal(rolled!.revision, 5);
  const original = parse(
    files.get(String((parse(files.get(indexTarget)).definitions as Doc[])[0]!.target)),
  );
  const restored = parse(rollback.get(String(rolled!.target)));
  assert.equal(restored.definition_schema, 1);
  assert.equal(restored.execution_contract, original.execution_contract);
  assert.ok(rollback.has(String(original.execution_contract)));
});
