import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assembleReviewedPublication,
  generatedPublicationProjection,
} from "./catalog-prepare-publication.mts";
import { readCatalogPublicationBundle } from "./release-catalog-inspection.mts";

const oldId = "chameleon-twist-jp-recompiled";
const heldId = "shipwright";
const indexTarget = "definitions/index.json";
const policyTarget = `policy/official/${oldId}.json`;
const launchTarget = `policy/official/${oldId}.launch.json`;
const bundle = fileURLToPath(
  new URL(
    "../docs/qualification/chameleon-twist-jp-managed-bundle-2026-10-30/bundle",
    import.meta.url,
  ),
);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const target = (bytes: Buffer) => `sha256/${hash(bytes)}.json`;
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function heldProjection(named = false) {
  const authored = readFileSync(
    new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
  );
  const catalog = named
    ? json({
        ports: [{
          id: heldId,
          reviewed_launch_contract_v1: { package_format: { "windows-x86-64": "tar.xz" } },
        }],
      })
    : authored;
  const template = json({
    contract_schema: 3,
    representation: "catalog_projection",
    catalog: { schema_version: 2, source_catalog: {}, ports: [] },
  });
  return {
    catalog,
    template,
    projection: generatedPublicationProjection(catalog, heldId, template),
  };
}

async function fixture(named = false) {
  const prior = await readCatalogPublicationBundle(bundle, performance.now() + 5000);
  const retained = [...prior.keys()].filter((name) => name.startsWith("sha256/"));
  assert.equal(retained.length, 2);
  const { catalog, template, projection } = heldProjection(named);
  const projectionTarget = target(projection);
  // This held fixture exercises assembly only. It supplies no reviewed Shipwright
  // authority. Actual Core inspection still owns every schema and scope check.
  const held = json({
    definition_schema: named ? 4 : 3,
    ...(named ? { required_features: ["runtime.reviewed-package-and-launch-v1"] } : {}),
    namespace: "official",
    stable_id: heldId,
    revision: 1,
    source_contracts: [projectionTarget],
    execution_contract: projectionTarget,
    persistence_contract: projectionTarget,
  });
  const heldTarget = target(held);
  const next = new Map(prior);
  const index = JSON.parse(prior.get(indexTarget)!.toString()) as {
    definitions: { namespace: string; stable_id: string; revision: number; target: string }[];
    contents: { target: string; sha256: string; length: number }[];
  };
  index.definitions.push({
    namespace: "official",
    stable_id: heldId,
    revision: 1,
    target: heldTarget,
  });
  for (const bytes of [held, projection])
    index.contents.push({ target: target(bytes), sha256: hash(bytes), length: bytes.length });
  const updatedIndex = json(index);
  next.set(indexTarget, updatedIndex);
  next.set(heldTarget, held);
  const oldPolicy = JSON.parse(prior.get(policyTarget)!.toString()) as {
    policy_revision: number;
    decision: { index_sha256: string; repository_id: number };
  };
  const oldLaunch = JSON.parse(prior.get(launchTarget)!.toString()) as {
    revision: number;
    policy_sha256: string;
  };
  const nextPolicy = json({
    ...oldPolicy,
    policy_revision: oldPolicy.policy_revision + 1,
    decision: { ...oldPolicy.decision, index_sha256: hash(updatedIndex) },
  });
  next.set(policyTarget, nextPolicy);
  next.set(
    launchTarget,
    json({
      ...oldLaunch,
      revision: oldLaunch.revision + 1,
      policy_sha256: hash(nextPolicy),
    }),
  );
  return {
    prior,
    next,
    retained,
    heldTarget,
    projectionTarget,
    projection,
    catalog,
    template,
    oldPolicy,
    oldLaunch,
  };
}

void test("a locally reconstructed Chameleon projection preserves the exact retained bytes", async () => {
  const prior = await readCatalogPublicationBundle(bundle, performance.now() + 5000);
  const projection = [...prior.values()].find((value) =>
    value.includes('"representation": "catalog_projection"'),
  )!;
  const selected = JSON.parse(projection.toString()) as { catalog: { ports: unknown[] } };
  const template = json({ ...selected, catalog: { ...selected.catalog, ports: [] } });
  // The actual published Chameleon is intentionally outside today's generated
  // managed routes. This is a local controlled use of the retained catalog.
  const generated = generatedPublicationProjection(json(selected.catalog), oldId, template);
  assert.deepEqual(JSON.parse(generated.toString()), selected);
  assert.deepEqual(assembleReviewedPublication(prior, prior, oldId, generated), {
    files: prior,
    contents: projection,
  });
});

void test("a generated route assembles deterministically and retains Chameleon content", async () => {
  const f = await fixture();
  const once = assembleReviewedPublication(f.prior, f.next, heldId, f.projection);
  const twice = assembleReviewedPublication(
    f.prior,
    f.next,
    heldId,
    generatedPublicationProjection(f.catalog, heldId, f.template),
  );
  assert.deepEqual(once, twice);
  assert.deepEqual(once.files.get(f.projectionTarget), f.projection);
  for (const filename of f.retained)
    assert.deepEqual(once.files.get(filename), f.prior.get(filename));
  assert.deepEqual(once.files.get(policyTarget), f.next.get(policyTarget));
  assert.deepEqual(once.files.get(launchTarget), f.next.get(launchTarget));
  assert.throws(
    () => generatedPublicationProjection(f.catalog, oldId, f.template),
    /missing or ambiguous/u,
  );
  assert.throws(
    () =>
      assembleReviewedPublication(
        f.prior,
        f.next,
        heldId,
        Buffer.concat([f.projection, Buffer.from(" ")]),
      ),
    /projection digest differs/u,
  );
});

void test("an authored loader reaches preparation with one schema 3 entry and leaf", async () => {
  const f = await fixture();
  const prepared = assembleReviewedPublication(f.prior, f.next, heldId, f.projection);
  const projection = JSON.parse(prepared.contents.toString()) as {
    catalog: {
      ports: {
        mod_loader: { contract: unknown; repository: string };
        release: { repository: string };
      }[];
    };
  };
  const [port] = projection.catalog.ports;
  assert.ok(port);
  assert.deepEqual(port.mod_loader.contract, { id: "libultraship", version: "1" });
  assert.equal(port.mod_loader.repository, port.release.repository);
  assert.equal(prepared.files.get(f.projectionTarget), prepared.contents);

  const legacyTemplate = JSON.parse(f.template.toString()) as Record<string, unknown>;
  for (const previousSchema of [1, 2]) {
    legacyTemplate.contract_schema = previousSchema;
    assert.throws(
      () => generatedPublicationProjection(f.catalog, heldId, json(legacyTemplate)),
      /native mod loaders require catalog projection schema 3/u,
    );
  }
  const entry = JSON.parse(f.next.get(f.heldTarget)!.toString()) as Record<string, unknown>;
  entry.definition_schema = 2;
  assert.throws(
    () =>
      assembleReviewedPublication(
        f.prior,
        new Map([...f.next, [f.heldTarget, json(entry)]]),
        heldId,
        f.projection,
      ),
    /definition and generated projection schemas differ/u,
  );
});

void test("index additions refuse stale policy or launch inputs and revoked Chameleon scope", async () => {
  const f = await fixture();
  const attempt = (name: string, value: Buffer) =>
    assembleReviewedPublication(f.prior, new Map([...f.next, [name, value]]), heldId, f.projection);
  assert.throws(
    () => attempt(policyTarget, f.prior.get(policyTarget)!),
    /bind the new complete index/u,
  );
  assert.throws(() => attempt(launchTarget, f.prior.get(launchTarget)!), /bind the new policy/u);
  assert.throws(
    () =>
      attempt(
        policyTarget,
        json({
          ...f.oldPolicy,
          decision: { ...f.oldPolicy.decision, index_sha256: hash(f.next.get(indexTarget)!) },
        }),
      ),
    /policy_revision does not advance/u,
  );
  assert.throws(
    () =>
      attempt(
        policyTarget,
        json({
          ...f.oldPolicy,
          policy_revision: f.oldPolicy.policy_revision + 1,
          decision: {
            ...f.oldPolicy.decision,
            index_sha256: hash(f.next.get(indexTarget)!),
            repository_id: 1,
          },
        }),
      ),
    /grant changes retained scope/u,
  );
});


void test("named package authoring binds schema 4 entry to the exact schema 3 leaf", async () => {
  const f = await fixture(true);
  const prepared = assembleReviewedPublication(f.prior, f.next, heldId, f.projection);
  assert.ok(prepared);
  const oldTemplate = JSON.parse(f.template.toString()) as { contract_schema: number };
  oldTemplate.contract_schema = 2;
  assert.throws(
    () => generatedPublicationProjection(f.catalog, heldId, json(oldTemplate)),
    /named package and launch declarations require catalog projection schema 3/u,
  );
});
