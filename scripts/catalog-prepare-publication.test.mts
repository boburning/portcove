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

const platformIndependentSource = {
  id: "community",
  authority: "link_out",
  platforms: [],
  name: "Community mods",
  instructions: "Follow the author's setup.",
  source: { kind: "external_portal", site: "community_site", url: "https://mods.example.org/" },
};

type NamedFixture = boolean | "mod-source";

function heldProjection(named: NamedFixture = false) {
  const authored = readFileSync(
    new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url),
  );
  const catalog = named
    ? json({
        ports: [
          {
            id: heldId,
            ...(named === "mod-source"
              ? { mod_sources: [platformIndependentSource] }
              : {
                  reviewed_launch_contract_v1: {
                    package_format: { "windows-x86-64": "tar.xz" },
                  },
                }),
          },
        ],
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

async function fixture(named: NamedFixture = false) {
  const prior = await readCatalogPublicationBundle(bundle, performance.now() + 5000);
  const retained = [...prior.keys()].filter((name) => name.startsWith("sha256/"));
  assert.equal(retained.length, 2);
  const { catalog, template, projection } = heldProjection(named);
  const projectionTarget = target(projection);
  // This held fixture exercises assembly only. It supplies no reviewed Shipwright
  // authority. Actual Core inspection still owns every schema and scope check.
  const held = json({
    definition_schema: named ? 4 : 3,
    ...(named === "mod-source"
      ? { required_features: ["mods.platform-independent-portals-v1", "mods.sources-v1"] }
      : named
        ? { required_features: ["runtime.reviewed-package-and-launch-v1"] }
        : {}),
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

void test("a mod-source entry binds schema 4 to a schema 3 leaf with both reader names", async () => {
  const f = await fixture("mod-source");
  const prepared = assembleReviewedPublication(f.prior, f.next, heldId, f.projection);
  assert.deepEqual(prepared.files.get(f.projectionTarget), f.projection);
  const entry = JSON.parse(f.next.get(f.heldTarget)!.toString()) as Record<string, unknown>;
  for (const [features, error] of [
    [[], /mod sources require schema 4 and the named reader/u],
    [["mods.sources-v1"], /platform-independent mod portals require the named reader/u],
  ] as const) {
    entry.required_features = features;
    assert.throws(
      () =>
        assembleReviewedPublication(
          f.prior,
          new Map([...f.next, [f.heldTarget, json(entry)]]),
          heldId,
          f.projection,
        ),
      error,
    );
  }
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

void test("an exact compatibility artifact list requires the named indexed writer", async () => {
  const f = await fixture();
  const catalog = JSON.parse(f.catalog.toString()) as {
    ports: { id: string; managed_runtime_applies_to?: unknown }[];
  };
  const port = catalog.ports.find(({ id }) => id === heldId);
  assert.ok(port);
  port.managed_runtime_applies_to = [{ version: "v2", size: 31, sha256: "ee".repeat(32) }];
  const oldProjection = json({
    ...JSON.parse(f.template.toString()),
    contract_schema: 2,
  });
  assert.throws(
    () => generatedPublicationProjection(json(catalog), heldId, oldProjection),
    /require catalog projection schema 3/u,
  );
  const namedProjection = generatedPublicationProjection(json(catalog), heldId, f.template);
  assert.throws(
    () => assembleReviewedPublication(f.prior, f.next, heldId, namedProjection),
    /require schema 4 and the named reader/u,
  );
});

void test("an inert alternate forge proposal refuses production assembly at the grant boundary", async () => {
  const f = await fixture();
  const projection = json({
    ...JSON.parse(f.projection.toString()),
    reviewed_forge: { instance: { dialect: "forgejo-v1" } },
  });
  assert.throws(
    () => assembleReviewedPublication(f.prior, f.next, heldId, projection),
    /reviewed alternate forge publication requires an independent executable acquisition grant/u,
  );
});

void test("a new generated forge projection assembles only with separate exact reviewed grant bytes", async () => {
  const prior = await readCatalogPublicationBundle(bundle, performance.now() + 5000);
  const id = "fixture-reviewed-forge";
  const port = {
    id,
    name: "Forge proposal fixture",
    summary: "Inert keyless fixture for a new subject.",
    support_tier: "stable",
    adapter: "native-portable",
    platforms: ["linux-x86-64"],
    channels: ["stable"],
    project_url: "https://forge.example/group/fixture",
    release: { provider: "reviewed-forge", repository: "group/fixture" },
    executable_hints: { "linux-x86-64": ["fixture"] },
  };
  const selector = {
    platform: "linux-x86-64",
    channel: "stable",
    instance: {
      dialect: "forgejo-v1",
      api_root: "https://forge.example/api/v1",
      web_host: "forge.example",
      asset_hosts: ["assets.forge.example"],
    },
    artifact: {
      repository: "group/fixture",
      repository_id: 10,
      tag: "v1",
      release_id: 20,
      asset_id: 30,
      name: "fixture.zip",
      url: "https://assets.forge.example/fixture.zip",
      size: 99,
      sha256: "b".repeat(64),
    },
  };
  const template = {
    contract_schema: 3,
    representation: "catalog_projection",
    catalog: {
      schema_version: 3,
      source_catalog: { evidence: [], identities: [], contracts: [], validators: [] },
      ports: [],
    },
    reviewed_forge: selector,
  };
  const generatedCatalog = json({ ports: [port] });
  assert.throws(
    () =>
      generatedPublicationProjection(
        generatedCatalog,
        id,
        json({ ...template, reviewed_forge: undefined }),
      ),
    /schema-3 template with its exact selector and subject/u,
  );
  const projection = generatedPublicationProjection(generatedCatalog, id, json(template));
  const leaf = target(projection);
  const definition = json({
    definition_schema: 4,
    required_features: ["release.reviewed-forge-v1"],
    required_capabilities: [{ template: port.adapter, minimum_version: 1, maximum_version: 1 }],
    namespace: "official",
    stable_id: id,
    revision: 1,
    port,
    source_contracts: [leaf],
    execution_contract: leaf,
    persistence_contract: leaf,
    artifact_bindings: [],
    evidence_references: [],
  });
  const index = JSON.parse(prior.get(indexTarget)!.toString()) as {
    definitions: { namespace: string; stable_id: string; revision: number; target: string }[];
    contents: { target: string; sha256: string; length: number }[];
  };
  index.definitions.push({
    namespace: "official",
    stable_id: id,
    revision: 1,
    target: target(definition),
  });
  for (const bytes of [definition, projection])
    index.contents.push({
      target: target(bytes),
      sha256: hash(bytes),
      length: bytes.length,
    });
  const indexBytes = json(index);
  const priorPolicy = JSON.parse(prior.get(policyTarget)!.toString()) as {
    policy_revision: number;
    decision: object;
  };
  const rebound = json({
    ...priorPolicy,
    policy_revision: priorPolicy.policy_revision + 1,
    decision: { ...priorPolicy.decision, index_sha256: hash(indexBytes) },
  });
  const priorLaunch = JSON.parse(prior.get(launchTarget)!.toString()) as { revision: number };
  const reviewed = new Map([
    ...prior,
    [indexTarget, indexBytes],
    [target(definition), definition],
    [policyTarget, rebound],
    [
      launchTarget,
      json({
        ...priorLaunch,
        revision: priorLaunch.revision + 1,
        policy_sha256: hash(rebound),
      }),
    ],
  ]);
  const forgePolicy = `policy/official/${id}.json`;
  assert.throws(
    () => assembleReviewedPublication(prior, reviewed, id, projection),
    /requires an independent executable acquisition grant/u,
  );
  const grant = {
    policy_schema: 5,
    namespace: "official",
    stable_id: id,
    policy_revision: 1,
    grant_id: "reviewed-forge-v1-qualification-fixture",
    decision: {
      status: "managed_forge_v1",
      definition_revision: 1,
      index_sha256: hash(indexBytes),
      definition_sha256: hash(definition),
      template: port.adapter,
      selection: selector,
    },
  };
  const grantBytes = json(grant);
  reviewed.set(forgePolicy, grantBytes);
  const assembled = assembleReviewedPublication(prior, reviewed, id, projection);
  assert.equal(assembled.files.get(forgePolicy), grantBytes);
  assert.equal(assembled.files.get(leaf), projection);
  assert.deepEqual(assembled.files.get(policyTarget), rebound);
  assert.equal(assembled.files.has(`policy/official/${id}.launch.json`), false);
  for (const decision of [
    { ...grant.decision, definition_sha256: "e".repeat(64) },
    { ...grant.decision, index_sha256: "e".repeat(64) },
    {
      ...grant.decision,
      selection: { ...selector, artifact: { ...selector.artifact, asset_id: 31 } },
    },
  ])
    assert.throws(
      () =>
        assembleReviewedPublication(
          prior,
          new Map([...reviewed, [forgePolicy, json({ ...grant, decision })]]),
          id,
          projection,
        ),
      /requires the exact schema-5 acquisition grant/u,
    );
  assert.throws(
    () => assembleReviewedPublication(assembled.files, reviewed, id, projection),
    /new subject without an existing publisher scope/u,
  );
  assert.throws(
    () =>
      assembleReviewedPublication(
        prior,
        new Map([...reviewed, [`policy/official/${id}.launch.json`, json({})]]),
        id,
        projection,
      ),
    /without a launch record/u,
  );
});

void test("schema-4 PS1 tool generation accepts only the compiled exact pack for each lane", async () => {
  const id = "fixture-psx";
  const artifacts = JSON.parse(
    readFileSync(
      new URL("../crates/portcove-core/catalog/tool-artifacts.json", import.meta.url),
      "utf8",
    ),
  ) as { platform: string; sha256: string }[];
  const tool = artifacts[0]!;
  const catalog = json({
    ports: [{ id, adapter: "psx-recomp-managed", platforms: [tool.platform] }],
  });
  const template = {
    contract_schema: 4,
    representation: "catalog_projection",
    catalog: { schema_version: 3, source_catalog: {}, ports: [] },
    tool_artifacts: [tool],
  };
  const projection = generatedPublicationProjection(catalog, id, json(template));
  const projected = JSON.parse(projection.toString()) as { tool_artifacts: unknown };
  assert.deepEqual(projected.tool_artifacts, [tool]);
  assert.throws(
    () =>
      generatedPublicationProjection(
        catalog,
        id,
        json({
          ...template,
          tool_artifacts: [{ ...tool, sha256: "c".repeat(64) }],
        }),
      ),
    /differs from the independently accepted executable pack/u,
  );
  assert.throws(
    () => generatedPublicationProjection(catalog, id, json({ ...template, tool_artifacts: [] })),
    /requires a complete schema-4 managed platform scope/u,
  );
  const f = await fixture();
  assert.throws(
    () => assembleReviewedPublication(f.prior, f.next, heldId, projection),
    /requires the named schema-4 reader/u,
  );
});
