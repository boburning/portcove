import assert from "node:assert/strict";
import test from "node:test";

import {
  planPortStageReconciliation,
  qualifiedPlatforms,
  validatePortStageSemantics,
} from "./roadmap.mts";
import { renderPortIssueBody } from "./roadmap-issue.mts";

import { fixtureFind, fixtureElement, fixtureObject } from "./fixtures/roadmap-fixtures.mts";

function qualificationScope(portId: string, platform = "windows") {
  return {
    port_id: portId,
    platform,
    artifact_sha256: "a".repeat(64),
    upstream_ref: "v1",
    contract_id: "fixture-contract",
    variant: {
      state: "exact",
      identity: {
        game_id: "fixture-game",
        variant_id: "retail",
        representation_id: "canonical",
      },
    },
    check_version: "fixture-v1",
  };
}

void test("Port stage validation is evidence-based and platform-scoped", () => {
  const catalog = {
    ports: [
      {
        id: "no-evidence",
        support_tier: "stable",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
      {
        id: "automated",
        support_tier: "beta",
        platforms: ["windows"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: [],
      },
      {
        id: "windows-qualified",
        support_tier: "alpha",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
    ],
  };
  const item = (id: string, stage: string, blocker?: string) => ({
    id: `item-${id}-${stage}`,
    title: `[Port] ${id}`,
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: `https://github.com/boburning/portcove/issues/${id}`,
      body: renderPortIssueBody({
        title: id,
        upstream: `https://example.test/${id}`,
        catalogId: id,
        ...(blocker === undefined ? {} : { blocker }),
      }),
    },
  });
  assert.deepEqual(
    validatePortStageSemantics(catalog, [item("no-evidence", "Cataloged")]).errors,
    [],
  );
  assert.deepEqual(
    validatePortStageSemantics(catalog, [item("automated", "Automated qualification")]).errors,
    [],
  );
  const stableOverclaim = validatePortStageSemantics(catalog, [item("no-evidence", "Supported")]);
  assert.ok(stableOverclaim.errors.some((value) => value.includes("no automated evidence")));
  assert.ok(stableOverclaim.errors.some((value) => value.includes("no platform with matching")));
  const supported = validatePortStageSemantics(catalog, [item("windows-qualified", "Supported")]);
  assert.deepEqual(supported.errors, []);
  assert.deepEqual(qualifiedPlatforms(catalog.ports[2]), ["windows"]);
  assert.match(fixtureElement(supported.diagnostics, 0), /qualified platforms = windows/);
  assert.ok(
    validatePortStageSemantics(catalog, [item("windows-qualified", "Cataloged")]).warnings.length >
      0,
  );
});

void test("Port stage validation consumes only passed exact qualification records", () => {
  const port = {
    id: "exact",
    platforms: ["windows", "linux"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const record = (kind: string, outcome: string, platform = "windows") => ({
    scope: qualificationScope(port.id, platform),
    kind,
    outcome,
  });
  const item = (stage: string) => ({
    id: `exact-${stage}`,
    title: "[Port] Exact",
    "port stage": stage,
    content: {
      type: "Issue",
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Exact",
        upstream: "https://example.test/exact",
        catalogId: port.id,
      }),
    },
  });
  const records = [
    record("automated_lifecycle", "passed"),
    record("automated_lifecycle", "passed"),
    record("known_failure", "failed"),
    record("hands_on", "passed"),
    record("structural_check", "passed", "linux"),
    record("automated_lifecycle", "failed", "linux"),
  ];
  const catalog = { ports: [port], source_catalog: { qualification: records } };

  assert.deepEqual(qualifiedPlatforms(port, records), ["windows"]);
  assert.deepEqual(validatePortStageSemantics(catalog, [item("Supported")]).errors, []);
  assert.match(
    fixtureElement(validatePortStageSemantics(catalog, [item("Supported")]).diagnostics, 0),
    /qualified platforms = windows/,
  );

  for (const disallowed of [
    [record("structural_check", "passed")],
    [record("automated_lifecycle", "failed")],
    [record("automated_lifecycle", "passed", "steam-deck")],
  ]) {
    const result = validatePortStageSemantics(
      { ports: [port], source_catalog: { qualification: disallowed } },
      [item("Automated qualification")],
    );
    assert.ok(result.errors.some((value) => value.includes("no automated evidence")));
  }

  const handsOnOnly = validatePortStageSemantics(
    {
      ports: [port],
      source_catalog: { qualification: [record("hands_on", "passed")] },
    },
    [item("Supported")],
  );
  assert.ok(handsOnOnly.errors.some((value) => value.includes("manual evidence without matching")));
  assert.ok(handsOnOnly.errors.some((value) => value.includes("no platform with matching")));

  const undeclaredHandsOn = validatePortStageSemantics(
    {
      ports: [port],
      source_catalog: {
        qualification: [
          record("automated_lifecycle", "passed"),
          record("hands_on", "passed", "steam-deck"),
        ],
      },
    },
    [item("Automated qualification")],
  );
  assert.ok(
    undeclaredHandsOn.errors.some(
      (value) =>
        value.includes("manual evidence without matching declared automated qualification") &&
        value.includes("steam-deck"),
    ),
  );
});

void test("Supported requires complete matching exact scopes and separate legacy intersections", () => {
  const port = {
    id: "scoped",
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  };
  const auto = {
    scope: qualificationScope(port.id),
    kind: "automated_lifecycle",
    outcome: "passed",
  };
  const hands = { ...structuredClone(auto), kind: "hands_on" };
  const item = {
    id: "scoped",
    title: "[Port] Scoped",
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Scoped",
        upstream: "https://example.test/scoped",
        catalogId: port.id,
      }),
    },
  };
  assert.deepEqual(qualifiedPlatforms(port, [auto, hands]), ["windows"]);
  for (const path of [
    ["port_id"],
    ["platform"],
    ["artifact_sha256"],
    ["upstream_ref"],
    ["contract_id"],
    ["variant", "identity", "game_id"],
    ["variant", "identity", "variant_id"],
    ["variant", "identity", "representation_id"],
    ["check_version"],
  ]) {
    const changed = structuredClone(hands);
    const parent = fixtureObject(
      path.slice(0, -1).reduce<unknown>((value, key) => fixtureObject(value)[key], changed.scope),
    );
    const key = path.at(-1);
    assert.ok(key);
    const previous = parent[key];
    assert.ok(typeof previous === "string");
    parent[key] = key === "artifact_sha256" ? "b".repeat(64) : `${previous}-different`;
    const records = [auto, changed];
    assert.deepEqual(qualifiedPlatforms(port, records), [], path.join("."));
    const result = validatePortStageSemantics(
      { ports: [port], source_catalog: { qualification: records } },
      [item],
    );
    assert.ok(
      result.errors.some((error) => error.includes("no platform with matching")),
      path.join("."),
    );
    assert.deepEqual(
      planPortStageReconciliation({ ports: [port], source_catalog: { qualification: records } }, [
        item,
      ]).map((change) => change.to),
      ["Automated qualification"],
    );
  }
  for (const path of [
    ["artifact_sha256"],
    ["upstream_ref"],
    ["contract_id"],
    ["check_version"],
    ["variant"],
    ["variant", "identity", "game_id"],
    ["variant", "identity", "variant_id"],
    ["variant", "identity", "representation_id"],
  ]) {
    const incomplete = structuredClone(hands);
    const parent = fixtureObject(
      path
        .slice(0, -1)
        .reduce<unknown>((value, key) => fixtureObject(value)[key], incomplete.scope),
    );
    const key = path.at(-1);
    assert.ok(key);
    delete parent[key];
    assert.deepEqual(qualifiedPlatforms(port, [auto, incomplete]), [], path.join("."));
    const incompleteAuto = { ...incomplete, kind: "automated_lifecycle" };
    assert.deepEqual(qualifiedPlatforms(port, [incompleteAuto, incomplete]), [], path.join("."));
  }
  const unknown = {
    ...structuredClone(hands),
    scope: { ...hands.scope, variant: { state: "unknown" } },
  };
  assert.deepEqual(qualifiedPlatforms(port, [auto, unknown]), []);
  for (const digest of [["a".repeat(64)], 42, {}]) {
    const malformedAuto = {
      ...structuredClone(auto),
      scope: { ...auto.scope, artifact_sha256: digest },
    };
    const malformedHands = { ...structuredClone(malformedAuto), kind: "hands_on" };
    assert.deepEqual(qualifiedPlatforms(port, [malformedAuto, malformedHands]), []);
    const malformedCatalog = {
      ports: [port],
      source_catalog: {
        qualification: [malformedAuto, malformedHands],
      },
    };
    assert.ok(
      validatePortStageSemantics(malformedCatalog, [
        { ...item, "port stage": "Automated qualification" },
      ]).errors.some((error) => error.includes("no automated evidence")),
    );
  }
  const failed = { ...hands, outcome: "failed" };
  assert.deepEqual(qualifiedPlatforms(port, [auto, failed]), []);
  const legacyAuto = { ...port, automated_tested_platforms: ["windows"] };
  const legacyHands = { ...port, manually_validated_platforms: ["windows"] };
  assert.deepEqual(qualifiedPlatforms(legacyAuto, [hands]), []);
  assert.deepEqual(qualifiedPlatforms(legacyHands, [auto]), []);
  assert.deepEqual(
    qualifiedPlatforms({ ...legacyAuto, manually_validated_platforms: ["windows"] }, []),
    ["windows"],
  );
  assert.deepEqual(qualifiedPlatforms(port, [hands, auto, hands]), ["windows"]);
});

void test("Port stage validation rejects broken manual evidence non-catalog overclaim and unsupported rejection", () => {
  const invalidManual = {
    id: "manual-only",
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: ["windows"],
  };
  const nonCatalog = {
    title: "[Port] Candidate",
    "port stage": "Supported",
    content: {
      type: "Issue",
      url: "https://github.com/boburning/portcove/issues/1",
      body: renderPortIssueBody({
        title: "Candidate",
        upstream: "https://example.test/candidate",
        portKey: "candidate",
      }),
    },
  };
  assert.ok(
    validatePortStageSemantics({ ports: [invalidManual] }, [nonCatalog]).errors.some((value) =>
      value.includes("exactly one valid catalog ID"),
    ),
  );
  assert.ok(
    validatePortStageSemantics({ ports: [invalidManual] }, []).errors.some((value) =>
      value.includes("manual evidence without matching"),
    ),
  );

  const blocked = structuredClone(nonCatalog);
  blocked["port stage"] = "Blocked";
  blocked.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    portKey: "candidate",
    blocker: "No artifact exists. Resume when upstream publishes one.",
  });
  const rejected = structuredClone(nonCatalog);
  rejected["port stage"] = "Rejected";
  assert.deepEqual(validatePortStageSemantics({ ports: [] }, [blocked, rejected]).errors, []);
  const invalidBlocked = structuredClone(blocked);
  invalidBlocked.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    portKey: "candidate",
  });
  assert.ok(
    validatePortStageSemantics({ ports: [] }, [invalidBlocked]).errors.some((value) =>
      value.includes("lacks a usable blocker and exact resume condition"),
    ),
  );

  const catalogRejected = structuredClone(rejected);
  catalogRejected.content.body = renderPortIssueBody({
    title: "Candidate",
    upstream: "https://example.test/candidate",
    catalogId: "candidate",
  });
  assert.ok(
    validatePortStageSemantics(
      {
        ports: [
          {
            id: "candidate",
            platforms: [],
            automated_tested_platforms: [],
            manually_validated_platforms: [],
          },
        ],
      },
      [catalogRejected],
    ).errors.some((value) => value.includes("still represented as catalog-supported")),
  );
});

void test("Supported reconciliation only downgrades overstatement and becomes idempotent after application", () => {
  const catalog = {
    ports: [
      {
        id: "none",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
      {
        id: "auto",
        platforms: ["windows"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: [],
      },
      {
        id: "qualified",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
    ],
  };
  const item = (id: string) => ({
    id,
    title: `[Port] ${id}`,
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: id,
      body: renderPortIssueBody({
        title: id,
        upstream: `https://example.test/${id}`,
        catalogId: id,
      }),
    },
  });
  const items = catalog.ports.map((port) => item(port.id));
  const plan = planPortStageReconciliation(catalog, items);
  assert.deepEqual(
    plan.map((change) => [change.itemId, change.to]),
    [
      ["none", "Cataloged"],
      ["auto", "Automated qualification"],
    ],
  );
  for (const change of plan)
    fixtureFind(items, (candidate) => candidate.id === change.itemId)["port stage"] = change.to;
  assert.deepEqual(planPortStageReconciliation(catalog, items), []);
});

void test("Supported reconciliation planning uses exact automated and hands-on records", () => {
  const ports = ["none", "auto", "qualified"].map((id) => ({
    id,
    platforms: ["windows"],
    automated_tested_platforms: [],
    manually_validated_platforms: [],
  }));
  const qualification = [
    {
      scope: qualificationScope("auto"),
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: qualificationScope("qualified"),
      kind: "automated_lifecycle",
      outcome: "passed",
    },
    {
      scope: qualificationScope("qualified"),
      kind: "hands_on",
      outcome: "passed",
    },
  ];
  const items = ports.map((port) => ({
    id: port.id,
    title: `[Port] ${port.id}`,
    "port stage": "Supported",
    content: {
      type: "Issue",
      number: port.id,
      body: renderPortIssueBody({
        title: port.id,
        upstream: `https://example.test/${port.id}`,
        catalogId: port.id,
      }),
    },
  }));

  assert.deepEqual(
    planPortStageReconciliation({ ports, source_catalog: { qualification } }, items).map(
      (change) => [change.itemId, change.to],
    ),
    [
      ["none", "Cataloged"],
      ["auto", "Automated qualification"],
    ],
  );
});
